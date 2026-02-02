#include "common/uniforms"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Bind groups
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

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
