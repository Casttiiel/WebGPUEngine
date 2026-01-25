struct FroxelUniforms {
  froxelDimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
}

// Bind groups
@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(1) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let froxelCoord = globalId.xyz;
  
  // Bounds check
  if (froxelCoord.x >= u32(froxelParams.froxelDimensions.x) ||
    froxelCoord.y >= u32(froxelParams.froxelDimensions.y) ||
    froxelCoord.z >= u32(froxelParams.froxelDimensions.z)) {
    return;
  }

  let densityFinal = volumetricParams.fogDensity;//baseDensity * heightFactor * noiseFactor;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;
  
  // Store density in 3D texture (R32F format)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(sigmaS, sigmaT, 0.0, 0.0));
}
