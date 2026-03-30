#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
#include "common/octahedral"
#include "common/gbuffer"

// LightUniforms for point lights with shadow support.
// Fields that are irrelevant for point lights are repurposed:
//   viewProjOffset  — unused (point lights have no single view-projection)
//   shadowStep      — repurposed as shadowNear (near plane of each cube face camera)
//   shadowInverseResolution — repurposed as shadowFar (far plane = light radius)
struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,             // 16 bytes (0-15)
    position: vec3<f32>,         // 12 bytes (16-27)
    intensity: f32,              // 4 bytes  (28-31)
    viewProjOffset: mat4x4<f32>, // 64 bytes (32-95) — unused for point lights
    radius: f32,                 // 4 bytes  (96-99)
    shadowNear: f32,             // 4 bytes  (100-103) repurposed from shadowStep
    shadowFar: f32,              // 4 bytes  (104-107) repurposed from shadowInverseResolution
    shadowStepDivResolution: f32,// 4 bytes  (108-111) unused
    startFalloff: f32,           // 4 bytes  (112-115)
    padding: vec3<f32>,          // 12 bytes (116-127)
    extraPadding: f32,           // 4 bytes  (128-131)
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var gPointShadowCube: texture_depth_cube;
@group(3) @binding(2) var gShadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>; // bound to white, unused
@group(3) @binding(4) var projectorSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

@fragment
fn PS_point_lights_shadow(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    let g = decodeGBuffer(pos);

    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = length(light_dir_full);
    let light_dir = light_dir_full / distance_to_light;

    // Normal bias: shift the shadow query point along the surface normal,
    // scaled by the angle of incidence — maximum at grazing angles where
    // depth-only bias is insufficient to prevent acne on flat surfaces.
    let NdL_raw = dot(g.normal, light_dir);
    let normalBiasScale = clamp(1.0 - NdL_raw, 0.0, 1.0);
    let biasedWorldPos = g.worldPos + g.normal * 0.05 * normalBiasScale;

    // Shadow sample MUST happen before any non-uniform early return.
    let shadow_factor = getShadowFactorCube(
        biasedWorldPos,
        light.position.xyz,
        light.shadowNear,
        light.shadowFar,
        light.shadowStepDivResolution,
        gPointShadowCube,
        gShadowSampler,
    );

    let NdL = max(NdL_raw, 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);

    let h = normalize(light_dir + g.viewDir);
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);

    // Inner/outer radius attenuation (same as non-shadow point light)
    let d = distance_to_light;
    let r0 = light.startFalloff;
    let r1 = light.radius;
    var att = 1.0;
    if (d > r0) {
        let t = saturate((d - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);

    let diffuse_contrib  = kD * cDiff;
    let specular_contrib = cSpec;

    let hl = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, pos, 0.0).r;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * light.intensity * shadow_factor * (diffuse_contrib * hl + specular_contrib * NdL) * att * ms;
    return vec4<f32>(final_color, 1.0);
}
