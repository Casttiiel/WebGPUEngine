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
    // Scene sun (offset 116 = byte 464): xyz = direction toward the sun, w = 1 if present.
    sunDirection: vec4<f32>,
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
  dimensions: vec4<f32>,      // xyz: grid dimensions, w: debug view (1 = fog only)
  sunPartial: f32,            // 1 = raymarch resolves the last partial slice with an exact per-pixel sun shadow tap
  farPlane: f32,              // depth covered by the grid (view-space metres)
  depthDistScale: f32,        // S in depth(s) = (exp2(s/S) - 1) / B
  depthDistB: f32,            // B
  jitter: vec4<f32>,          // xyz: per-frame sample offset inside the froxel [0,1), w: history weight (0 = reset)
  prevViewProj: mat4x4<f32>,  // previous frame view-projection (temporal reprojection)
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
  noise:       vec4<f32>,   // bytes 48-63 — x=amount, y=scale (1/m), z=speed (m/s), w=edgeBreakup
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

// Froxel Coordinate Functions - shared by every froxel pass.
//
// DEPTH DISTRIBUTION
// Slices follow an exponential curve that starts at depth 0 (camera) and ends at
// farPlane (UE-style "linear near, exponential far"):
//
//   depth(s) = (exp2(s / S) - 1) / B          s ∈ [0, N]  (continuous slice coord)
//   s(depth) = S * log2(1 + depth * B)
//
// S = depthDistScale (bigger → more linear), B = (exp2(N / S) - 1) / farPlane.
// A pure log curve (near·(far/near)^t) wastes ~40% of the slices inside the first
// metre and makes the far slices several metres thick — the main source of fog
// leaking through walls. With S = N/2 the slice thickness only grows ~4x from near
// to far.
//
// SLICE / TEXEL CONVENTION
// Slice k spans [depth(k), depth(k+1)].
// Per-froxel data (density, light) is evaluated inside slice k.
// The integrated texture stores at texel k the result from the camera up to the
// FAR boundary depth(k+1), so lookups at depth d use texel coordinate s(d) - 1.

fn froxelSliceToDepth(s: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return (exp2(s / depthDistScale) - 1.0) / depthDistB;
}

fn froxelDepthToSlice(depth: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return depthDistScale * log2(1.0 + max(depth, 0.0) * depthDistB);
}

// Compute view space ray direction (z = -1 plane, NOT normalised) from UV coordinates.
// Note: Assumes camera uniforms are available with invProjection matrix
fn computeViewRayFromUV(uv: vec2<f32>, invProjection: mat4x4<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  let rayH = invProjection * ndc;
  let ray = rayH.xyz / rayH.w;
  // Scale so that ray.z == -1: multiplying by a view depth gives the position.
  return ray / max(-ray.z, 1e-8);
}

// View-space position of a continuous froxel coordinate.
// coord.xy in [0, dims.xy] (froxel centre = index + 0.5), coord.z in [0, dims.z].
// froxel y = 0 is the TOP row of the screen.
fn froxelCoordToViewSpace(
  coord: vec3<f32>,
  froxelDimensions: vec3<f32>,
  depthDistScale: f32,
  depthDistB: f32,
  invProjection: mat4x4<f32>
) -> vec3<f32> {
  var uv = coord.xy / froxelDimensions.xy;
  uv.y = 1.0 - uv.y;
  let ray = computeViewRayFromUV(uv, invProjection);
  let depth = froxelSliceToDepth(coord.z, depthDistScale, depthDistB);
  return ray * depth;
}

// Ratio between the distance travelled along the view ray and the view-depth
// delta for the column through `uvTopDown` (1 at the screen centre, > 1 at edges).
fn froxelRayLengthScale(uvTopDown: vec2<f32>, invProjection: mat4x4<f32>) -> f32 {
  let ray = computeViewRayFromUV(vec2<f32>(uvTopDown.x, 1.0 - uvTopDown.y), invProjection);
  return length(ray);
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let gg = g * g;
  let denom = pow(max(1.0 + gg - 2.0 * g * cosTheta, 1e-4), 1.5);
  return (1.0 - gg) / (12.566370614 * denom); // 4π
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

// Number of march steps toward the sun.  12 gives reasonable quality;
// step size is derived from farPlane so they always span the full grid.
const SELF_OCC_STEPS: u32 = 12u;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = froxelParams.dimensions;

    if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y) || gid.z >= u32(dims.z)) {
        return;
    }

    // ── View-space position of this froxel ───────────────────────────────────
    let froxelVS = froxelCoordToViewSpace(
        vec3<f32>(gid) + vec3<f32>(0.5), dims.xyz,
        froxelParams.depthDistScale, froxelParams.depthDistB,
        camera.invProjection
    );

    // ── Light direction in view space (direction toward light) ───────────────
    // dirLight.position = lightDirectionToSource (world-space, normalized)
    let LdirVS = normalize((camera.viewMatrix * vec4<f32>(dirLight.position, 0.0)).xyz);

    let far   = froxelParams.farPlane;
    let dimsI = vec3<i32>(i32(dims.x), i32(dims.y), i32(dims.z));

    // Step size: cover 1.5× the far plane so diagonal / low-angle sun marches
    // still span the entire depth range.
    let stepSize = far * 1.5 / f32(SELF_OCC_STEPS);

    // Fast perspective coefficients (jitter is subpixel at froxel resolution)
    // projectionMatrix is column-major in WGSL: [col][row]
    let P00 = camera.projectionMatrix[0][0];
    let P11 = camera.projectionMatrix[1][1];

    var T: f32 = 1.0;

    for (var i: u32 = 0u; i < SELF_OCC_STEPS; i++) {
        let sampleVS = froxelVS + LdirVS * (f32(i) + 0.5) * stepSize;
        let viewDist = -sampleVS.z;  // positive distance from camera

        // Outside depth range → clear sky, no more medium to accumulate
        if (viewDist <= 0.0 || viewDist >= far) {
            break;
        }

        // Fast perspective-divide to froxel UV (no full mat4 multiply needed)
        let invW = 1.0 / viewDist;
        let uvX  = P00 * sampleVS.x * invW * 0.5 + 0.5;
        let uvY  = 1.0 - (P11 * sampleVS.y * invW * 0.5 + 0.5);

        // Clamp to frustum edge instead of breaking — lets the march continue
        // accumulating when the sun is near the horizon and steps exit the
        // screen boundary, using edge-froxel density as the off-screen proxy.
        let ix = clamp(i32(uvX * dims.x), 0, dimsI.x - 1);
        let iy = clamp(i32(uvY * dims.y), 0, dimsI.y - 1);
        let iz = clamp(
            i32(froxelDepthToSlice(viewDist, froxelParams.depthDistScale, froxelParams.depthDistB)),
            0, dimsI.z - 1);

        let sigmaT = max(textureLoad(froxelDensityTexture, vec3<i32>(ix, iy, iz), 0).g, 0.0);
        T *= exp(-sigmaT * stepSize);

        if (T < 0.01) {
            T = 0.0;
            break;
        }
    }

    textureStore(froxelSelfOcclusionTexture, vec3<i32>(gid), vec4<f32>(T, 0.0, 0.0, 0.0));
}
