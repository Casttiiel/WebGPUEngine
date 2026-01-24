#include "common/uniforms"
#include "common/structs"


@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;
@group(0) @binding(2) var froxelIntegratedTexture: texture_3d<f32>;
@group(0) @binding(3) var linearSampler: sampler;

// G-Buffer depth for proper ray termination
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;


struct FroxelUniforms {
  dimensions: vec3<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  stepSize: f32
}

fn depth01ToFroxelZ(depth01: f32) -> f32 {
  // ✅ si tu froxel Z es lineal con ndc.z (lo que tú estás usando ahora)
  // si luego usas log slicing, aquí se cambia
  return depth01;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let depth01 = textureSample(gLinearDepth, samplerGBuffer, uv).x;

  let dimsF = froxelParams.dimensions;

  // XY froxel coord desde pantalla
  let fx = clamp(uv.x * dimsF.x, 0.0, dimsF.x - 1.0);
  let fy = clamp(uv.y * dimsF.y, 0.0, dimsF.y - 1.0);

  // Z froxel coord desde depth
  let z01 = depth01ToFroxelZ(depth01);
  let fz = clamp(z01 * dimsF.z, 0.0, dimsF.z - 1.0);

  // UVW normalizado para trilinear sample
  let uvw = (vec3<f32>(fx, fy, fz) + vec3<f32>(0.5)) / dimsF;

  // sample integrated volume
  let integrated = textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);
  let S = integrated.rgb;
  let T = integrated.a;

  let alpha = clamp(1.0 - T, 0.0, 1.0);

  return vec4<f32>(S, alpha);
}