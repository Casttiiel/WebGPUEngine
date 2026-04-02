#include "common/uniforms"
#include "common/structs"
#include "common/volumetric/structs"


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


fn depth01ToViewZ(depth01: f32) -> f32 {
  // gLinearDepth debe ser lineal 0..1, hardcoded near/far as we don't receive camera data
  return depth01 * 1000.0; // depth01 * cameraFar
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
  let dimsF = froxelParams.dimensions.xyz;

  let fx = clamp(uv.x * dimsF.x, 0.0, dimsF.x - 1.0);
  let fy = clamp(uv.y * dimsF.y, 0.0, dimsF.y - 1.0);

  // Animate blue noise offset with golden-ratio frame progression so TAA
  // can average out the dithering pattern across frames.
  let frameTime   = volumetricSettings.windDir.w;           // camera.time packed into unused w component
  let frameOffset = fract(frameTime * 0.61803398874);       // golden ratio per-frame shift
  let noiseUV = fract(uv * vec2<f32>(volumetricSettings.renderWidth, volumetricSettings.renderHeight) / 64.0 + frameOffset);
  let dither = textureSample(blueNoiseTex, nearestSampler, noiseUV).r - 0.5;

  // Dither en Z en view space.
  // Clamp the dithered Z so it never exceeds the true scene depth — without
  // this a positive dither on a pixel right in front of a surface would push
  // the froxel lookup past the surface and leak fog from behind it.
  let depth01 = textureSample(gLinearDepth, samplerGBuffer, uv).x;
  let viewZ = depth01ToViewZ(depth01);
  let ditherViewZ = min(viewZ * (1.0 + dither * 0.02), viewZ);
  let z01 = viewZToFroxelZLog(ditherViewZ, froxelParams.nearPlane, froxelParams.farPlane);
  let fz = clamp(z01 * dimsF.z, 0.0, dimsF.z - 1.0);

  // Dither XY
  let ditherX = dither * 0.5;
  let ditherY = (fract(dither + 0.5) - 0.5) * 0.5;

  let uvw = (vec3<f32>(fx + ditherX, fy + ditherY, fz) + vec3<f32>(0.5)) / dimsF;

  let integrated = textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);

  return vec4<f32>(integrated.rgb, integrated.a);
}