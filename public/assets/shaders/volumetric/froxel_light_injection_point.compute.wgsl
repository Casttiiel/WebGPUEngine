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
@group(3) @binding(1) var shadowCube: texture_depth_cube;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

// Same layout as point_light_shadow.fs (shadowStep / shadowInverseResolution are
// repurposed as the cube face near / far planes).
struct LightUniforms {
  color: vec3<f32>,
  hasShadows: f32,
  position: vec3<f32>,   // world
  intensity: f32,
  viewProjOffset: mat4x4<f32>,
  radius: f32,
  shadowNear: f32,
  shadowFar: f32,
  shadowStepDivResolution: f32,
  startFalloff: f32,
  padding: vec3<f32>,
  extraPadding: f32,
};

// Single-tap cube shadow (compute-safe: textureSampleCompareLevel).
// The cube faces store perspective depth whose view Z is the dominant axis of
// the light→point vector; see getShadowFactorCube in common/lighting/shadows.
fn pointShadow(wPos: vec3<f32>) -> f32 {
  let dir = wPos - light.position;
  let a = abs(dir);
  let faceZ = max(max(a.x, a.y), a.z);
  if (faceZ < light.shadowNear || faceZ > light.shadowFar) {
    return 1.0;
  }
  let A = light.shadowFar / (light.shadowFar - light.shadowNear);
  let B = -(light.shadowFar * light.shadowNear) / (light.shadowFar - light.shadowNear);
  // Small constant bias in depth units — fog has no surface acne to fight.
  let depth = clamp(A + B / faceZ - 0.0005, 0.0, 1.0);
  let xDom = a.x >= a.y && a.x >= a.z;
  let sampleDir = select(vec3<f32>(-dir.x, dir.y, dir.z), vec3<f32>(dir.x, dir.y, -dir.z), xDom);
  return textureSampleCompareLevel(shadowCube, shadowSampler, sampleDir, depth);
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimsU = vec3<u32>(froxelParams.dimensions.xyz);

  if (gid.x >= dimsU.x || gid.y >= dimsU.y || gid.z >= dimsU.z) {
    return;
  }

  let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z));

  let existing = textureLoad(froxelLightTexture, coord, 0); // .a = sun factor, passed through

  // Jittered sample inside the froxel — the temporal pass integrates it.
  let froxelVS = froxelCoordToViewSpace(
    vec3<f32>(gid) + froxelParams.jitter.xyz,
    froxelParams.dimensions.xyz,
    froxelParams.depthDistScale,
    froxelParams.depthDistB,
    camera.invProjection
  );
  let froxelWorldPos = (camera.invView * vec4<f32>(froxelVS, 1.0)).xyz;

  let lightVec = light.position - froxelWorldPos;
  let d = length(lightVec);

  // fuera del radio => copiar
  if (d >= light.radius) {
    textureStore(froxelLightOutput, coord, existing);
    return;
  }

  var visibility = 1.0;
  if (light.hasShadows > 0.5) {
    visibility = pointShadow(froxelWorldPos);
  }

  let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
  let Ldir = lightVec / max(d, 1e-4);

  let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

  let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95) * volumetricSettings.gLightFactor;
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

  let contribution = light.color * light.intensity * att * phase * visibility;

  textureStore(froxelLightOutput, coord, vec4<f32>(existing.rgb + contribution, existing.a));
}
