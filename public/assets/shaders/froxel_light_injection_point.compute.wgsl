#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // read
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // write

@group(3) @binding(0) var<uniform> light: LightUniforms;

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


fn froxelZToViewZLinear(zSlice: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
    let z01 = (f32(zSlice) + 0.5) / f32(slices);
    return nearZ + z01 * (farZ - nearZ); // distancia positiva
}

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    // ⚠️ aquí NO flip Y (solo si tu engine lo necesita)
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / max(rayH.w, 1e-6));
}

// ✅ Froxel coord -> View space position
fn froxelToViewSpace(froxel: vec3<u32>) -> vec3<f32> {
    let dimsU = vec3<u32>(froxelParams.dimensions);

    // uv centro del tile
    var uv = (vec2<f32>(froxel.xy) + vec2<f32>(0.5)) / froxelParams.dimensions.xy;
    uv.y = 1 - uv.y;
    // view ray
    let viewRay = computeViewRayFromUV(uv);

    // viewZ (distancia positiva)
    let viewZ = froxelZToViewZLinear(froxel.z, dimsU.z, froxelParams.nearPlane, froxelParams.farPlane);

    // ✅ tu convención: delante = Z negativo
    return viewRay * viewZ;
}


fn worldToView(pWS: vec3<f32>) -> vec3<f32> {
  let v = camera.viewMatrix * vec4<f32>(pWS, 1.0);
  return v.xyz;
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimsU = vec3<u32>(froxelParams.dimensions);

  if (gid.x >= dimsU.x || gid.y >= dimsU.y || gid.z >= dimsU.z) {
    return;
  }

  let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z));

  let existing = textureLoad(froxelLightTexture, coord, 0).rgb;

  let froxelVS = froxelToViewSpace(gid);
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