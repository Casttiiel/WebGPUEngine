#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
#include "common/octahedral"
#include "common/gbuffer"

struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>, //This will be the direction
    intensity: f32,
    viewProjOffset: mat4x4<f32>,
    radius: f32, //Not used
    shadowStep: f32,
    shadowInverseResolution: f32,
    shadowStepDivResolution: f32,
    startFalloff: f32, //Not used
    padding: vec3<f32>,
    extraPadding: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> light: LightUniforms;
@group(2) @binding(1) var gShadowMap: texture_depth_2d;
@group(2) @binding(2) var gShadowSampler: sampler_comparison;
// Contact shadow factor [0,1]: 1.0 = lit, 0.0 = occluded
@group(2) @binding(3) var contactShadowMap:     texture_2d<f32>;
@group(2) @binding(4) var contactShadowSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;


@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    
    if(g.zlinear >= 1.0){
        discard;
    }

    // Shadow factor entre 0 (totalmente en sombra) y 1 (no ocluido)
    var shadow_factor = 1.0;
    let light_dir = normalize(light.position); // this will be used as a directional light
    if (light.hasShadows > 0.5) {
        shadow_factor = getShadowFactor(g.worldPos, light.viewProjOffset, light.shadowStepDivResolution, gShadowMap, gShadowSampler, false);
    }

    
    let NdL = max(saturate(dot(g.normal, light_dir)), 0.05);
    let NdV = max(saturate(dot(g.normal, g.viewDir)), 0.05);
    let h = normalize(light_dir + g.viewDir); // half vector
    
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);
    
    // PBR calculations
    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);
    
    // Energy conservation: especular ya incluye Fresnel, solo calculamos kD
    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F; // Specular contribution
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic); // Diffuse contribution
    
    // Aplicar energy conservation correctamente
    let diffuse_contrib = kD * cDiff;
    let specular_contrib = cSpec; // cSpec ya incluye Fresnel

    let hl  = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, uv, 0.0).r;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * (diffuse_contrib * hl + specular_contrib * NdL) * light.intensity * shadow_factor * ms;

    // Apply contact shadow factor (1.0 = lit, 0.0 = occluded)
    let contactFactor = textureSampleLevel(contactShadowMap, contactShadowSampler, uv, 0.0).r;
    return vec4<f32>(final_color * contactFactor, 1.0);
}