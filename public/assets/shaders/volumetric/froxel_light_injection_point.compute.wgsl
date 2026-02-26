#include "common/uniforms"
#include "common/structs"
#include "common/core/constants"
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

  let d = length(lightVS - froxelVS);

  // fuera del radio => copiar
  if (d >= light.radius) {
    textureStore(froxelLightOutput, coord, vec4<f32>(existing, 1.0));
    return;
  }

  let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
  let froxelWorldPos = tempFroxelWS.xyz / tempFroxelWS.w;
  let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
  let Ldir = normalize(light.position - froxelWorldPos);

  let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

  let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95) / 3.0;
  let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
  let phaseMie = phaseHG(cosTheta, g);

  // Peso típico: casi todo Mie para shafts
  let phase = mix(phaseRayleigh, phaseMie, 0.9);

  let r0 = light.startFalloff; // radio interior (intensidad máxima)
  let r1 = light.radius;       // radio exterior (intensidad 0)
    
  // Atenuación con inner/outer radius
  var att = 1.0;
  if (d > r0) {
      // Transición suave de 1.0 a 0.0 entre r0 y r1
      let t = saturate((d - r0) / max(r1 - r0, 0.001));
      // Smoothstep inverso: 1.0 → 0.0
      att = 1.0 - t * t * (3.0 - 2.0 * t);
  }

  let contribution = light.color * light.intensity * att * phase;

  textureStore(froxelLightOutput, coord, vec4<f32>(existing + contribution, 1.0));
}