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

// Bind groups
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

@group(3) @binding(0) var noiseTex: texture_2d<f32>;
@group(3) @binding(1) var noiseSampler: sampler;
@group(3) @binding(2) var linearDepth: texture_2d<f32>;
@group(3) @binding(3) var<uniform> fogVolumeData: FogVolumeData;

// Triplanar sample of the RGB tileable noise texture at a given world position and scale.
// Uses the 3 channels for independent variation across projections.
fn triplanarNoise(worldPos: vec3<f32>, scale: f32, windOffset: vec3<f32>) -> f32 {
    let p    = (worldPos + windOffset) * scale;
    let dims = vec2<f32>(textureDimensions(noiseTex));

    let uv1 = fract(p.xy); let uv2 = fract(p.yz); let uv3 = fract(p.zx);

    // Each projection uses a different channel so they blend independently
    let c1 = textureLoad(noiseTex, vec2<i32>(uv1 * dims), 0).r;  // XY → R
    let c2 = textureLoad(noiseTex, vec2<i32>(uv2 * dims), 0).g;  // YZ → G
    let c3 = textureLoad(noiseTex, vec2<i32>(uv3 * dims), 0).b;  // ZX → B
    return (c1 + c2 + c3) * 0.3333;
}

// FBM: 3 octaves of triplanar noise with wind advection per octave.
// Slower-moving large scales + faster-moving small details = turbulent wisps.
// windDir.xz = Wind singleton direction×speed (world units/s, XZ plane only).
// windDir.y is repurposed for cameraFar — never use it as wind.
fn sampleNoise3D(worldPos: vec3<f32>) -> f32 {
    // Horizontal wind only (Y=0 keeps fog layer from drifting vertically)
    let wind = vec3<f32>(volumetricParams.windDir.x, 0.0, volumetricParams.windDir.z) * camera.time;

    // Octave 1 – large base shape (slow)
    let n1 = triplanarNoise(worldPos, 0.012, wind * 1.0);
    // Octave 2 – medium detail (medium speed)
    let n2 = triplanarNoise(worldPos, 0.030, wind * 1.7);
    // Octave 3 – fine wisps (fast)
    let n3 = triplanarNoise(worldPos, 0.075, wind * 2.8);

    // FBM weights: 1 + 0.5 + 0.25 = 1.75
    return (n1 + n2 * 0.5 + n3 * 0.25) / 1.75;
}

// -----------------------------------------------------------------------
// Fog Volume SDF helpers
// -----------------------------------------------------------------------

/// Signed distance to an axis-aligned box centered at the origin.
fn sdfBox(p: vec3<f32>, halfExtents: vec3<f32>) -> f32 {
    let d = abs(p) - halfExtents;
    return length(max(d, vec3<f32>(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
}

/// Signed distance to a sphere centered at the origin.
fn sdfSphere(p: vec3<f32>, radius: f32) -> f32 {
    return length(p) - radius;
}

/// Applies all active fog volumes on top of the base sigmaS / sigmaT values.
/// Returns vec2(finalSigmaS, finalSigmaT).
fn applyFogVolumes(worldPos: vec3<f32>, baseSigmaS: f32, baseSigmaT: f32) -> vec2<f32> {
    var outS = baseSigmaS;
    var outT = baseSigmaT;

    for (var i = 0u; i < fogVolumeData.count; i++) {
        let vol = fogVolumeData.volumes[i];

        // Signed distance from froxel world position to volume surface
        let localPos = worldPos - vol.center;
        var sdf: f32;
        if (vol.shape < 0.5) {
            // Sphere — halfExtents.x stores the radius
            sdf = sdfSphere(localPos, vol.halfExtents.x);
        } else {
            // Box
            sdf = sdfBox(localPos, vol.halfExtents);
        }

        // blend = 1 inside, smoothly falls to 0 over [0, falloff] outside the surface
        let blend = saturate(smoothstep(0.0, vol.falloff, -sdf));

        if (blend > 0.0) {
            if (vol.blendMode < 0.5) {
                // "add" — accumulate density on top of the global fog
                outS += vol.sigmaS * blend;
                outT += vol.sigmaT * blend;
            } else {
                // "override" — lerp toward the volume's density (clears fog in interiors)
                outS = mix(outS, vol.sigmaS, blend);
                outT = mix(outT, vol.sigmaT, blend);
            }
        }
    }

    return vec2<f32>(outS, outT);
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let froxelCoord = globalId.xyz;
  
  // Bounds check
  if (froxelCoord.x >= u32(froxelParams.dimensions.x) ||
    froxelCoord.y >= u32(froxelParams.dimensions.y) ||
    froxelCoord.z >= u32(froxelParams.dimensions.z)) {
    return;
  }

  let froxelVS = froxelToViewSpace(
    globalId, 
    froxelParams.dimensions.xyz,
    froxelParams.nearPlane,
    froxelParams.farPlane,
    camera.invProjection
  );
  let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
  let froxelWS = tempFroxelWS.xyz / tempFroxelWS.w;

  // Depth rejection has been removed: the integration pass stores one result
  // per slice and the raymarch pass already clamps its Z lookup to scene
  // depth, so froxels behind geometry are simply never sampled.  Rejecting
  // them in the density pass created a ~half-froxel dark halo around every
  // object edge.

  // 2) Height fog (parameters from uniform)
  let fogBaseHeight = volumetricParams.fogBaseHeight;
  let fogLayerHeight = volumetricParams.fogLayerHeight;
  let fogFalloff = volumetricParams.fogFalloff;

  let h = froxelWS.y - fogBaseHeight;

  // Altura normalizada dentro de la capa
  let layerT = saturate(h / fogLayerHeight);

  // Capa más densa abajo
  let layerShape = smoothstep(0.0, 1.0, 1.0 - layerT);

  // Decay arriba
  let above = max(h - fogLayerHeight, 0.0);
  let expFalloff = exp(-above * fogFalloff);

  let heightFog = layerShape * expFalloff;

  // Base density
  var densityFinal = volumetricParams.fogDensity * heightFog;

  // 3D Noise
  let noise = sampleNoise3D(froxelWS);

  // Más noise abajo
  let heightMask = saturate(1.0 - layerT);
  let layeredNoise = mix(1.0, noise, heightMask);

  // Mucho más contraste para shafts
  let shapedNoise = smoothstep(0.2, 0.8, layeredNoise);
  let noiseFactor = mix(0.5, 1.8, shapedNoise);

  densityFinal *= noiseFactor;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;

  // Apply world-space density volumes (SDF blend)
  let finalParams = applyFogVolumes(froxelWS, sigmaS, sigmaT);
  
  // Store density in 3D texture (R32F format)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(finalParams.x, finalParams.y, 0.0, 0.0));
}
