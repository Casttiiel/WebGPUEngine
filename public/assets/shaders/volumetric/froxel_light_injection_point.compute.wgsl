#include "common/uniforms"
#include "common/structs"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // read
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // write

@group(3) @binding(0) var<uniform> light: LightUniforms;

struct LightUniforms {
  color: vec3<f32>,
  hasShadows: f32,
  position: vec3<f32>,   // world
  intensity: f32,
  viewProjOffset: mat4x4<f32>,
  radius: f32,
  shadowStep: f32,
  shadowInverseResolution: f32,
  shadowStepDivResolution: f32,
  startFalloff: f32,
  padding: vec3<f32>,
  extraPadding: f32,
};

fn worldToView(pWS: vec3<f32>) -> vec3<f32> {
  let v = camera.viewMatrix * vec4<f32>(pWS, 1.0);
  return v.xyz;
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimsU = vec3<u32>(froxelParams.dimensions.xyz);

  if (gid.x >= dimsU.x || gid.y >= dimsU.y || gid.z >= dimsU.z) {
    return;
  }

  let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z));

  let existing = textureLoad(froxelLightTexture, coord, 0).rgb;

  let froxelVS = froxelToViewSpace(
    gid,
    froxelParams.dimensions.xyz,
    froxelParams.nearPlane,
    froxelParams.farPlane,
    camera.invProjection
  );
  let lightVS  = worldToView(light.position);

  let dist = length(lightVS - froxelVS);

  // fuera del radio => copiar
  if (dist >= light.radius) {
    textureStore(froxelLightOutput, coord, vec4<f32>(existing, 1.0));
    return;
  }

  let denom = max(light.radius - light.startFalloff, 1e-4);
  let x = max(dist - light.startFalloff, 0.0) / denom;
  let att = clamp(1.0 - x, 0.0, 1.0);

  let contribution = light.color * light.intensity * att;

  textureStore(froxelLightOutput, coord, vec4<f32>(existing + contribution, 1.0));
}