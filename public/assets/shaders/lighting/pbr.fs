#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
#include "common/octahedral"
#include "common/gbuffer"

struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,// 16 bytes (0-15)
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
    // From worldPos to Light (assuming light position is at origin for now)
    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = abs(length(light_dir_full));
    let light_dir = light_dir_full / distance_to_light;
    if(use_shadows){
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

    if(fix_shadows || use_shadows){
        let almostScreenPos = light.viewProjOffset * worldPos;
        let screenPos = almostScreenPos.xyz / almostScreenPos.w;
        let projectorUv = screenPos.xy * 0.5 + 0.5;
        let projector = textureSampleLevel(projectorTexture, projectorSampler, projectorUv.xy, 0.0).r;
        shadow_factor *= projector;
    }
    
    let NdL = max(dot(g.normal, light_dir), 0.0); // No minimum lighting on back faces
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    let h = normalize(light_dir + g.viewDir); // half vector
    
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);
    
    // PBR calculations
    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);
    
    // Attenuation: intensidad máxima hasta startFalloff, luego atenuación suave hasta radius
    let d = distance_to_light;
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

    // Energy conservation: especular ya incluye Fresnel, solo calculamos kD
    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F; // Specular contribution
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic); // Diffuse contribution
    
    // Aplicar energy conservation correctamente
    let diffuse_contrib = kD * cDiff;
    let specular_contrib = cSpec; // cSpec ya incluye Fresnel
    
    let hl = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, iPosition, 0.0).b;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * light.intensity * shadow_factor * (diffuse_contrib * hl + specular_contrib * NdL) * att * ms;
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
@group(3) @binding(3) var projectorTexture: texture_2d<f32>;
@group(3) @binding(4) var projectorSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

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