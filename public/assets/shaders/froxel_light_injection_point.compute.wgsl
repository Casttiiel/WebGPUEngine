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
  dimensions: vec3<f32>,
  padding1: f32,
  nearPlane: f32,
  farPlane: f32,
  logDepthScale: f32,
  logDepthBias: f32,
};

struct VolumetricUniforms {
  density: f32,
  scattering: f32,
  absorption: f32,
  anisotropy: f32,

  fogHeightFalloff: f32,
  fogDistanceFalloff: f32,
  noiseScale: f32,
  noiseStrength: f32,

  windDirection: vec3<f32>,
  windSpeed: f32,

  time: f32,
  maxDistance: f32,
  stepSize: f32,
  padding3: f32,
};

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

fn froxelZToViewDistanceLinear(zSlice: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
    let z01 = (f32(zSlice) + 0.5) / f32(slices);
    return nearZ + z01 * (farZ - nearZ);
}

fn froxelToViewSpace(froxel: vec3<u32>) -> vec3<f32> {
    let dims = froxelParams.dimensions; // vec3<f32> (recomendado)

    // 1) XY -> UV del centro del tile
    let uv = (vec2<f32>(froxel.xy) + 0.5) / dims.xy;

    // 2) UV -> NDC XY
    var ndcXY = uv * 2.0 - 1.0;

    // ✅ UV tiene Y hacia abajo, NDC hacia arriba
    ndcXY.y = -ndcXY.y;

    // 3) NDC -> rayo en view-space
    // clip.z = 1 y w = 1 solo para generar dirección
    let clip = vec4<f32>(ndcXY, 1.0, 1.0);
    let viewH = camera.invProjection * clip;
    let rayVS = normalize(viewH.xyz / viewH.w);

    // 4) Slice Z -> distancia real positiva
    let slices = u32(dims.z);
    let dist = froxelZToViewDistanceLinear(froxel.z, slices, froxelParams.nearPlane, froxelParams.farPlane);

    // 5) Convertimos a Z de view-space (delante = NEGATIVO)
    let viewZ = -dist;

    // 6) Punto del rayo a ese Z
    // rayVS.z debería ser NEGATIVO normalmente mirando hacia delante
    let t = viewZ / min(rayVS.z, -1e-4);

    return rayVS * t;
}

fn worldToView(pWS: vec3<f32>) -> vec3<f32> {
  var v = camera.viewMatrix * vec4<f32>(pWS, 1.0);
  return v.xyz;
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimsU = vec3<u32>(froxelParams.dimensions);

  if (gid.x >= dimsU.x || gid.y >= dimsU.y || gid.z >= dimsU.z) {
    //return;
  }

  let coordI32 = vec3<i32>(gid);

  // Luz ya acumulada
  let existing = textureLoad(froxelLightTexture, coordI32, 0).rgb;

  // ✅ view-space froxel position (metros reales)
  let froxelVS = froxelToViewSpace(gid);

  // ✅ view-space light position
  let lightVS = worldToView(light.position);

  let dist = length(lightVS - froxelVS);

  // fuera del radio => copiar
  //if (froxelVS.z < -1.0) {//dist >= light.radius
    //textureStore(froxelLightOutput, coordI32, vec4<f32>(existing, 1.0));
    textureStore(froxelLightOutput, coordI32, vec4<f32>(50,0,0, 1.0));
    //return;
  //}

  let denom = max(light.radius - light.startFalloff, 1e-4);
  let x = max(dist - light.startFalloff, 0.0) / denom;
  let att = clamp(1.0 - x, 0.0, 1.0);

  let contribution = light.color * light.intensity;

  textureStore(froxelLightOutput, coordI32, vec4<f32>(existing + contribution, 1.0));
}