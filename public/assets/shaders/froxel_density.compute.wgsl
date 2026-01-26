#include "common/uniforms"

struct FroxelUniforms {
  dimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Bind groups
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

fn froxelZToViewZLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ * pow(farZ / max(nearZ, 1e-6), z01);
}

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    // ⚠️ aquí NO flip Y (solo si tu engine lo necesita)
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / max(rayH.w, 1e-8));
}

// ✅ Froxel coord -> View space position
fn froxelToViewSpace(froxel: vec3<u32>) -> vec3<f32> {
    let dimsU = vec3<u32>(froxelParams.dimensions.xyz);

    // uv centro del tile
    var uv = (vec2<f32>(froxel.xy) + vec2<f32>(0.5)) / froxelParams.dimensions.xy;
    uv.y = 1 - uv.y;
    // view ray
    let rayVS = computeViewRayFromUV(uv);

    // viewZ (distancia positiva)
    let viewDist = froxelZToViewZLog(froxel.z, dimsU.z, froxelParams.nearPlane, froxelParams.farPlane);

    let t = -viewDist / min(rayVS.z, -1e-6);

    return rayVS * t;
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

  let froxelVS = froxelToViewSpace(globalId);
  let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
  let froxelWS = tempFroxelWS.xyz / tempFroxelWS.w;

  // 2) Height fog
  let fogBaseHeight: f32 = 0.0;     // y=0 suelo
  let fogLayerHeight: f32 = 10.0;   // 30m uniformes
  let fogFalloff: f32 = 0.3;       // decaimiento arriba

  let h = froxelWS.y - fogBaseHeight;

  // Dentro de la capa: uniforme
  // Por arriba: exp decay
  let above = max(h - fogLayerHeight, 0.0);
  let heightFactor = exp(-above * fogFalloff);

  // opcional clamp
  let hf = clamp(heightFactor, 0.0, 1.0);


  // 3) Densidad final del medio
  let densityFinal = volumetricParams.fogDensity * hf;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;
  
  // Store density in 3D texture (R32F format)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(sigmaS, sigmaT, 0.0, 0.0));
}
