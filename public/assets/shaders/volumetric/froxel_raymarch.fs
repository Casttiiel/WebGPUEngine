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
  // cameraFar is packed into volumetricSettings.windDir.y by FroxelVolumetricScattering.ts
  return depth01 * volumetricSettings.windDir.y;
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

  // Dither in froxel Z-space (±0.5 froxels) so each pair of adjacent frames
  // samples on opposite sides of a slice boundary.  TAA then averages them,
  // eliminating the visible step between slices.
  // We also clamp the final fz to scene depth so we never leak fog from
  // behind geometry.
  let depth01 = textureSample(gLinearDepth, samplerGBuffer, uv).x;
  let viewZ   = depth01ToViewZ(depth01);
  let z01     = viewZToFroxelZLog(viewZ, froxelParams.nearPlane, froxelParams.farPlane);
  // ±0.5 froxel dither — spans exactly one slice at any depth
  let fzScene = z01 * dimsF.z;

  // Cap the Z lookup to floor(fzScene): the last froxel slice whose texel
  // centre sits strictly in front of the GBuffer surface.
  //
  // Why floor and not fzScene directly?
  //   textureSampleLevel maps fz → uvw.z = (fz + 0.5) / numSlices.
  //   Trilinear then blends between floor(uvw.z * N - 0.5) and ceil() texels.
  //   When fz = K (integer), uvw.z lands exactly on texel K's centre → zero
  //   blending with texel K+1 (the wall slice).
  //   When fz = K + ε, the GPU starts pulling in texel K+1 → leak.
  //   Capping at floor(fzScene) ensures fz ≤ K so the ceil texel is always
  //   K or less — never the slice that straddles the geometry boundary.
  let fzMax = floor(fzScene);
  let fz    = clamp(fzScene + dither, 0.0, fzMax);  // never reach the wall slice

  // Dither XY
  let ditherX = dither * 0.5;
  let ditherY = (fract(dither + 0.5) - 0.5) * 0.5;

  let uvw = (vec3<f32>(fx + ditherX, fy + ditherY, fz) + vec3<f32>(0.5)) / dimsF;

  let integrated = textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);

  return vec4<f32>(integrated.rgb, integrated.a);
}