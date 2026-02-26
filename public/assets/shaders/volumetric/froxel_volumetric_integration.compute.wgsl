#include "common/volumetric/structs"
#include "common/volumetric/froxel"

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