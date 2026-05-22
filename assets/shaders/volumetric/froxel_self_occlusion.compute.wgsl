// Froxel Self-Occlusion Pass
// For each froxel, marches a ray toward the directional light through the
// density volume, accumulating Beer-law transmittance.  The result (0..1)
// is stored per-froxel and later multiplied with the directional contribution
// in the light injection pass, so dense fog correctly shadows deeper fog.
struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

// Volumetric Structs - Consolidated from 4 froxel shaders
// This file eliminates 800+ lines of duplicated code

struct FroxelUniforms {
  dimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  multipleScatteringBoost: f32,
  anisotropy: f32,
  fogBaseHeight: f32,
  fogLayerHeight: f32,
  fogFalloff: f32,
  ambientVolumetricIntensity: f32,
  gLightFactor: f32,
  renderWidth: f32,
  renderHeight: f32,
  windDir: vec4<f32>,  // pre-scaled wind vector (XZ plane, world units/s); set from Wind singleton
}

// -----------------------------------------------------------------------
// Fog Volume — world-space density region evaluated per-froxel with SDF.
//
// Memory layout (64 bytes, 4 vec4 rows — matches TypeScript Float32Array[16]):
//   row 0  [0..2]  center.xyz       [3]     shape (0=sphere, 1=box)
//   row 1  [4..6]  halfExtents.xyz  [7]     falloff
//   row 2  [8]     density          [9]     sigmaS   [10] sigmaT   [11] blendMode
//   row 3  [12..15] _pad
// -----------------------------------------------------------------------
struct FogVolume {
  center:      vec3<f32>,   // bytes  0-11
  shape:       f32,         // bytes 12-15  — 0=sphere, 1=box
  halfExtents: vec3<f32>,   // bytes 16-27
  falloff:     f32,         // bytes 28-31
  density:     f32,         // bytes 32-35
  sigmaS:      f32,         // bytes 36-39
  sigmaT:      f32,         // bytes 40-43
  blendMode:   f32,         // bytes 44-47  — 0=add, 1=override
  _pad:        vec4<f32>,   // bytes 48-63 (padding to 64-byte stride)
}

const MAX_FOG_VOLUMES: u32 = 16u;

// Uniform buffer:  16-byte header (count + 3 × padding u32) + 16 × FogVolume
struct FogVolumeData {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  volumes: array<FogVolume, 16>,
}

// Froxel Coordinate Functions - Consolidated from 4 froxel shaders
// This file eliminates duplication and ensures consistency

// ===========================
// DEPTH CONVERSION FUNCTIONS
// ===========================

// Convert froxel Z coordinate to view space depth using logarithmic distribution
fn froxelZToViewZLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ * pow(farZ / max(nearZ, 1e-6), z01);
}

// Calculate slice depth delta for logarithmic distribution
fn sliceDzLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z0 = froxelZToViewZLog(z, slices, nearZ, farZ);
  // Extrapolar más allá del último slice en vez de clampear
  let z1 = froxelZToViewZLog(z + 1u, slices, nearZ, farZ);
  return max(z1 - z0, 1e-4);
}

// ===========================
// COORDINATE TRANSFORMATION FUNCTIONS
// ===========================

// Compute view space ray direction from UV coordinates
// Note: Assumes camera uniforms are available with invProjection matrix
fn computeViewRayFromUV(uv: vec2<f32>, invProjection: mat4x4<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = invProjection * ndc;
    return normalize(rayH.xyz / max(rayH.w, 1e-8));
}

// Convert froxel coordinates to view space position
// Requires: FroxelUniforms (dimensions, nearPlane, farPlane)
fn froxelToViewSpace(
    froxel: vec3<u32>, 
    froxelDimensions: vec3<f32>,
    nearPlane: f32,
    farPlane: f32,
    invProjection: mat4x4<f32>
) -> vec3<f32> {
    let dimsU = vec3<u32>(froxelDimensions);

    // UV at center of tile
    var uv = (vec2<f32>(froxel.xy) + vec2<f32>(0.5)) / froxelDimensions.xy;
    uv.y = 1.0 - uv.y;  // Flip Y coordinate
    
    // View ray direction
    let rayVS = computeViewRayFromUV(uv, invProjection);

    // View space depth (positive distance)
    let viewDist = froxelZToViewZLog(froxel.z, dimsU.z, nearPlane, farPlane);

    // Calculate distance along ray
    let t = -viewDist / min(rayVS.z, -1e-6);

    return rayVS * t;
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
    let gg = g * g;
    let denom = pow(1.0 + gg - 2.0 * g * cosTheta, 1.5);
    // Normalización correcta con 4π
    return (1.0 - gg) / (12.566370614 * max(denom, 1e-4)); // 4π ≈ 12.566370614
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams:       FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Density volume (rg32float: R=sigmaS, G=sigmaT) — read-only
@group(2) @binding(0) var froxelDensityTexture:      texture_3d<f32>;
// Self-occlusion result (r32float: transmittance 0..1) — write
@group(2) @binding(1) var froxelSelfOcclusionTexture: texture_storage_3d<r32float, write>;

// Only need the light direction from the directional light uniform buffer
struct DirLightDir {
    color:     vec3<f32>,
    hasShadow: f32,
    position:  vec3<f32>,  // direction FROM scene TOWARD light (lightDirectionToSource)
    intensity: f32,
}
@group(3) @binding(0) var<uniform> dirLight: DirLightDir;

// ── Tuning ──────────────────────────────────────────────────────────────────
// 8 steps × 4 world-units = 32 m total march.  Enough to cross a 30 m fog
// layer even at sun elevations as low as ~60°.  Increase STEPS for higher
// quality at the cost of more compute.
const SELF_OCC_STEPS:     u32 = 8u;
const SELF_OCC_STEP_SIZE: f32 = 4.0;  // world-units per step
// ────────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = froxelParams.dimensions;

    if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y) || gid.z >= u32(dims.z)) {
        return;
    }

    // ── View-space position of this froxel ───────────────────────────────────
    let froxelVS = froxelToViewSpace(
        gid, dims.xyz,
        froxelParams.nearPlane, froxelParams.farPlane,
        camera.invProjection
    );

    // ── Light direction in view space (direction toward light) ───────────────
    // dirLight.position = lightDirectionToSource (world-space, normalized)
    let LdirVS = normalize((camera.viewMatrix * vec4<f32>(dirLight.position, 0.0)).xyz);

    let near   = froxelParams.nearPlane;
    let far    = froxelParams.farPlane;
    let dimsI  = vec3<i32>(i32(dims.x), i32(dims.y), i32(dims.z));
    let logFarNear = log(far / near);  // precompute once

    // Fast perspective coefficients (jitter is subpixel at froxel resolution)
    // projectionMatrix is column-major in WGSL: [col][row]
    let P00 = camera.projectionMatrix[0][0];
    let P11 = camera.projectionMatrix[1][1];

    var T: f32 = 1.0;

    for (var i: u32 = 0u; i < SELF_OCC_STEPS; i++) {
        let sampleVS  = froxelVS + LdirVS * (f32(i) + 0.5) * SELF_OCC_STEP_SIZE;
        let viewDist  = -sampleVS.z;  // positive distance from camera

        // Outside depth range → clear sky, no more medium to accumulate
        if (viewDist <= near || viewDist >= far) {
            break;
        }

        // Fast perspective-divide to froxel UV (no full mat4 multiply needed)
        let invW  = 1.0 / viewDist;
        let ndcX  = P00 * sampleVS.x * invW;
        let ndcY  = P11 * sampleVS.y * invW;
        let uvX   = ndcX * 0.5 + 0.5;
        let uvY   = 1.0 - (ndcY * 0.5 + 0.5);

        // Outside frustum → clear sky, stop
        if (uvX < 0.0 || uvX >= 1.0 || uvY < 0.0 || uvY >= 1.0) {
            break;
        }

        let ix = clamp(i32(uvX * dims.x), 0, dimsI.x - 1);
        let iy = clamp(i32(uvY * dims.y), 0, dimsI.y - 1);
        let iz = clamp(i32(log(viewDist / near) / logFarNear * dims.z), 0, dimsI.z - 1);

        let sigmaT = max(textureLoad(froxelDensityTexture, vec3<i32>(ix, iy, iz), 0).g, 0.0);
        T *= exp(-sigmaT * SELF_OCC_STEP_SIZE);

        if (T < 0.01) {
            T = 0.0;
            break;
        }
    }

    textureStore(froxelSelfOcclusionTexture, vec3<i32>(gid), vec4<f32>(T, 0.0, 0.0, 0.0));
}
