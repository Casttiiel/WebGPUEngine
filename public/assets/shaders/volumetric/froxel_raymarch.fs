#include "common/uniforms"
#include "common/structs"


@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;
@group(0) @binding(2) var froxelIntegratedTexture: texture_3d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var blueNoiseTex: texture_2d<f32>;
@group(0) @binding(5) var nearestSampler: sampler;

// G-Buffer depth for proper ray termination
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;


struct FroxelUniforms {
  dimensions: vec4<f32>,
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
}

fn depth01ToViewZ(depth01: f32) -> f32 {
  // gLinearDepth debe ser lineal 0..1, hardcoded near/far as we don't receive camera data
  return 0.1 + depth01 * (1000.0 - 0.1);
}

fn viewZToFroxelZLog(viewZ: f32, nearZ: f32, farZ: f32) -> f32 {
  let z = clamp(viewZ, nearZ, farZ);
  return log(z / nearZ) / log(farZ / nearZ);
}

fn depth01ToFroxelZ(depth01: f32) -> f32 {
  let viewZ = depth01ToViewZ(depth01);
  return viewZToFroxelZLog(viewZ, froxelParams.nearPlane, froxelParams.farPlane);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let depth01 = textureSample(gLinearDepth, samplerGBuffer, uv).x;

  let dimsF = froxelParams.dimensions.xyz;

  // XY froxel coord desde pantalla
  let fx = clamp(uv.x * dimsF.x, 0.0, dimsF.x - 1.0);
  let fy = clamp(uv.y * dimsF.y, 0.0, dimsF.y - 1.0);

  // Blue noise: tilea cada 64 pixels, centrado en 0
  let noiseUV = uv * vec2<f32>(2689, 1973) / 64.0;
  let dither = textureSample(blueNoiseTex, nearestSampler, noiseUV).r - 0.5;

  // Z froxel coord desde depth
  let viewZ = depth01ToViewZ(depth01);
  let ditherViewZ = viewZ * (1.0 + dither * 0.02); // ±1% en view space
  let z01 = viewZToFroxelZLog(ditherViewZ, froxelParams.nearPlane, froxelParams.farPlane);
  let fz = clamp(z01 * dimsF.z, 0.0, dimsF.z - 1.0);

  // UVW normalizado para trilinear sample
  let uvw = (vec3<f32>(fx + dither, fy + dither, fz) + vec3<f32>(0.5)) / dimsF;
  // sample integrated volume
  let integrated = textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);
  let S = integrated.rgb;  // In-scattering
  let T = integrated.a;    // Transmittance

  // Return S as RGB and T as alpha for composite: FinalColor = SceneColor * T + S
  return vec4<f32>(S, T);
}