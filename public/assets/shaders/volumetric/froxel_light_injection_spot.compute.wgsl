#include "common/uniforms"
#include "common/structs"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#include "common/lighting/shadows"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // read
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // write

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>;
@group(3) @binding(4) var projectorSampler: sampler;

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
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let froxelCoord = vec3<i32>(globalId);
    
    // Bounds check
    if (froxelCoord.x >= i32(froxelParams.dimensions.x) ||
        froxelCoord.y >= i32(froxelParams.dimensions.y) ||
        froxelCoord.z >= i32(froxelParams.dimensions.z)) {
        return;
    }

    let coord = vec3<i32>(i32(globalId.x), i32(globalId.y), i32(globalId.z));
    let existing = textureLoad(froxelLightTexture, coord, 0).rgb;
    
    let froxelVS = froxelToViewSpace(
        globalId,
        froxelParams.dimensions.xyz,
        froxelParams.nearPlane,
        froxelParams.farPlane,
        camera.invProjection
    );
    let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
    let froxelWorldPos = tempFroxelWS.xyz / tempFroxelWS.w;
    let almostScreenPos = light.viewProjOffset * vec4<f32>(froxelWorldPos, 1.0);
    let screenPos = almostScreenPos.xyz / almostScreenPos.w;
    // if out of range, shadow_factor = 0
    if (screenPos.x < -1.0 || screenPos.x > 1.0 || screenPos.y < -1.0 || screenPos.y > 1.0 || screenPos.z < 0.0 || screenPos.z > 1.0) {
        textureStore(froxelLightOutput, coord, vec4<f32>(existing, 1.0));
        return;
    }
    var visibility = getShadowFactorSimple(froxelWorldPos.xyz, light.viewProjOffset, light.shadowStepDivResolution, shadowMap, shadowSampler, true);    
    
    let projectorUv = screenPos.xy * 0.5 + 0.5;
    let projector = textureSampleLevel(projectorTexture, projectorSampler, projectorUv.xy, 0.0).r;
    visibility *= projector;

    let light_dir_full = light.position.xyz - froxelWorldPos;
    let distance_to_light = abs(length(light_dir_full));
    let light_dir = light_dir_full / distance_to_light;

    let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
    let Ldir = light_dir;

    let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

    // Forward scattering para god rays marcados
    // g = 0.7-0.8: god rays visibles
    // g = 0.85-0.9: god rays muy marcados (puede ser excesivo)
    let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95);
    let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
    let phaseMie = phaseHG(cosTheta, g);

    // Peso típico: casi todo Mie para shafts
    let phase = mix(phaseRayleigh, phaseMie, 0.9);

    let d = distance_to_light;
    let r0 = light.startFalloff; // radio interior (intensidad máxima)
    let r1 = light.radius;       // radio exterior (intensidad 0)
    var att = 1.0;
    if (d > r0) {
        // Transición suave de 1.0 a 0.0 entre r0 y r1
        let t = saturate((d - r0) / max(r1 - r0, 0.001));
        // Smoothstep inverso: 1.0 → 0.0
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    // Aplicar phase function directamente (sin mezclar con isotropic)
    // Esto da god rays claros cuando miras hacia la luz directional
    let contribution = light.color * light.intensity * visibility * phase * att;
    
    textureStore(froxelLightOutput, coord, vec4<f32>(existing + contribution, 1.0));
}