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

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Media: sigmaS,sigmaT (si es RG16F lo ideal es declararlo como texture_3d<f32>)
// En WebGPU, para storage/format combos a veces acabas usando rgba16float para todo.
@group(1) @binding(0) var froxelMediaTexture: texture_3d<f32>;     // R=sigmaS, G=sigmaT
@group(1) @binding(1) var froxelLightTexture: texture_3d<f32>;     // RGB = injected light
@group(1) @binding(2) var froxelIntegratedTexture: texture_storage_3d<rgba16float, write>;

const MAX_SLICES: u32 = 1024u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = froxelParams.dimensions;
  
  // 1 hilo por columna (x,y)
  if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y)) {
    return;
  }

  let slices = u32(dims.z);

  // Integración acumulada por columna
  var T: f32 = 1.0;                 // transmittance acumulada
  var S: vec3<f32> = vec3<f32>(0.0); // scattering acumulado (RGB)

  for (var z: u32 = 0u; z < MAX_SLICES; z = z + 1u) {//slices
    if (z >= slices) { break; }
    if (T < 0.001) {
        // Rellenar slices restantes con el valor actual
        for (var zz = z; zz < slices; zz++) {
            let c = vec3<i32>(i32(gid.x), i32(gid.y), i32(zz));
            textureStore(froxelIntegratedTexture, c, vec4<f32>(S, 0.0));
        }
        break;
    }
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(z));

    // Media coefficients
    // sigmaS: scattering coefficient
    // sigmaT: extinction coefficient = sigmaS + sigmaA
    let sigma = textureLoad(froxelMediaTexture, coord, 0);
    let sigmaS = max(sigma.r, 0.0);
    let sigmaT = max(sigma.g, 0.0);

    // Inyected lighting at this froxel
    let L = textureLoad(froxelLightTexture, coord, 0).rgb;

    let dz = sliceDzLog(z, slices, froxelParams.nearPlane, froxelParams.farPlane);

    // 1) In-scattering integration with multiple scattering boost:
    // dS = T * (L * sigmaS) * dz * boost

    // Cuando T es alto (zona poco densa): msBoost completo
    // Cuando T es bajo (zona muy densa): msBoost se acerca a 1.0 (sin boost)
    let msBoost = mix(volumetricSettings.multipleScatteringBoost, 1.0, 1.0 - T);
    S += T * (L * sigmaS * msBoost) * dz;

    // 2) Transmittance update:
    // T *= exp(-sigmaT * dz)
    T *= exp(-sigmaT * dz);

    // Guardamos resultado integrado hasta este slice
    // RGB = scattering integrado
    // A   = transmittance
    textureStore(froxelIntegratedTexture, coord, vec4<f32>(S, T));
  }
}