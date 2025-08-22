#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

struct LightUniforms {
    color: vec4<f32>,            // 16 bytes (0-15)
    position: vec3<f32>,         // 12 bytes (16-27)
    intensity: f32,              // 4 bytes  (28-31)
    viewProjOffset: mat4x4<f32>, // 64 bytes (32-95)
    radius: f32,                 // 4 bytes  (96-99)
    shadowStep: f32,             // 4 bytes  (100-103)
    shadowInverseResolution: f32, // 4 bytes (104-107)
    shadowStepDivResolution: f32, // 4 bytes (108-111)
    startFalloff: f32,           // 4 bytes  (112-115)
    padding: vec3<f32>,          // 12 bytes (116-127)
    extraPadding: f32,           // 4 bytes  (128-131) para llegar a 144 bytes
}

fn shade(iPosition: vec2<f32>, use_shadows: bool, fix_shadows: bool) -> vec4<f32> {
    let g = decodeGBuffer(iPosition);
    
    // Shadow factor entre 0 (totalmente en sombra) y 1 (no ocluido)
    var shadow_factor = 1.0;
    if (use_shadows) {
        shadow_factor = getShadowFactor(g.worldPos, light.viewProjOffset, light.shadowStepDivResolution, gShadowMap, gShadowSampler, true);
    }
    
    let worldPos = vec4<f32>(g.worldPos, 1.0);
    
    if (fix_shadows) {
        let almostScreenPos = light.viewProjOffset * worldPos;
        let screenPos = almostScreenPos.xyz / almostScreenPos.w;
        // if out of range, shadow_factor = 0
        if (screenPos.x < -1.0 || screenPos.x > 1.0 || screenPos.y < -1.0 || screenPos.y > 1.0 || screenPos.z < 0.0 || screenPos.z > 1.0) {
            shadow_factor = 0.0;
        }
    }    
    
    // From worldPos to Light (assuming light position is at origin for now)
    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = abs(length(light_dir_full));
    let light_dir = light_dir_full / distance_to_light;
    
    let NdL = saturate(dot(g.normal, light_dir));
    let NdV = saturate(dot(g.normal, g.viewDir));
    let h = normalize(light_dir + g.viewDir); // half vector
    
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);
    
    // PBR calculations
    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);
    
    // Attenuation
    let normalized_distance = max(distance_to_light - light.startFalloff, 0.0) / (light.radius - light.startFalloff);
    var att = saturate(1.0 - normalized_distance);

    // Energy conservation: specular contribution reduces diffuse
    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, a);
    let kS = F; // Specular contribution
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic); // Diffuse contribution
    
    // Aplicar energy conservation correctamente
    let diffuse_contrib = kD * cDiff;
    let specular_contrib = cSpec;
    
    let final_color = light.color.xyz * NdL * (diffuse_contrib + specular_contrib) * att * light.intensity * shadow_factor;
    return vec4<f32>(final_color, 1.0);
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var gShadowMap: texture_depth_2d;
@group(3) @binding(2) var gShadowSampler: sampler_comparison;

@fragment
fn PS_point_lights(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    return shade(pos, false, false);
}

@fragment
fn PS_dir_lights_no_shadow(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    return shade(pos, false, true);
}

@fragment
fn PS_dir_lights_shadow(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    return shade(pos, true, true);
}