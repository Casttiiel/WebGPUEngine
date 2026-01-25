struct FroxelUniforms {
  dimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  stepSize: f32
}

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Media: sigmaS,sigmaT (si es RG16F lo ideal es declararlo como texture_3d<f32>)
// En WebGPU, para storage/format combos a veces acabas usando rgba16float para todo.
@group(1) @binding(0) var froxelMediaTexture: texture_3d<f32>;     // R=sigmaS, G=sigmaT
@group(1) @binding(1) var froxelLightTexture: texture_3d<f32>;     // RGB = injected light
@group(1) @binding(2) var froxelIntegratedTexture: texture_storage_3d<rgba16float, write>;

fn sliceToDepthLinear(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ + z01 * (farZ - nearZ);
}

fn sliceToDepthLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ * pow(farZ / max(nearZ, 1e-6), z01);
}

fn sliceDzLinear(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z0 = sliceToDepthLog(z, slices, nearZ, farZ);
  let z1 = sliceToDepthLog(min(z + 1u, slices - 1u), slices, nearZ, farZ);
  return max(z1 - z0, 1e-4);
}

const MAX_SLICES: u32 = 128u;

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
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(z));

    // Media coefficients
    // sigmaS: scattering coefficient
    // sigmaT: extinction coefficient = sigmaS + sigmaA
    let sigma = textureLoad(froxelMediaTexture, coord, 0);
    let sigmaS = max(sigma.r, 0.0);
    let sigmaT = max(sigma.g, 0.0);

    // Inyected lighting at this froxel
    let L = textureLoad(froxelLightTexture, coord, 0).rgb;

    let dz = sliceDzLinear(z, slices, froxelParams.nearPlane, froxelParams.farPlane);

    // 1) In-scattering integration:
    // dS = T * (L * sigmaS) * dz
    // (esto es una versión simple, funciona muy bien en práctica)
    S += T * (L * sigmaS) * dz;

    // 2) Transmittance update:
    // T *= exp(-sigmaT * dz)
    T *= exp(-sigmaT * dz);

    // Guardamos resultado integrado hasta este slice
    // RGB = scattering integrado
    // A   = transmittance
    textureStore(froxelIntegratedTexture, coord, vec4<f32>(S, T));
  }
}