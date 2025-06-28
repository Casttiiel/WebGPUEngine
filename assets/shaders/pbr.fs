#include "common/uniforms"
#include "common/structs"
#include "common/utils"

const PI: f32 = 3.14159265359;

struct LightUniforms {
    color: vec4<f32>,
    position: vec3<f32>,
    intensity: f32,
    viewProjOffset: mat4x4<f32>,
    radius: f32,
    shadowStep: f32,
    shadowInverseResolution: f32,
    shadowStepDivResolution: f32,
}

// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}

fn decodeGBuffer(uv: vec2<f32>) -> GBuffer {
    var g: GBuffer;
    
    // Get linear depth and world position
    let zlinear = textureSample(gLinearDepth, samplerGBuffer, uv).x;
    g.zlinear = zlinear;
    g.worldPos = getWorldCoords(uv, zlinear, camera);
    
    // Get normal
    let normalData = textureSample(gNormals, samplerGBuffer, uv);
    g.normal = normalize(decodeNormal(normalData.xyz));
    
    // Get albedo and metallic
    let albedo = textureSample(gAlbedo, samplerGBuffer, uv);
    g.metallic = albedo.a;
    g.roughness = normalData.a;
    g.metallic = max(clamp(1.0 - normalData.a, 0.0, 1.0), g.metallic);
    
    // Gamma correction for albedo
    let albedoLinear = pow(abs(albedo.rgb), vec3<f32>(2.2));
    
    // Mix with metallic for proper albedo and specular
    g.albedo = albedoLinear * (1.0 - g.metallic);
    
    // Get self illumination
    g.emissive = textureSample(gSelfIllum, samplerGBuffer, uv).x;
    g.selfIllum = g.albedo * g.emissive;
    
    // Default specular for dielectrics is 0.03
    g.specularColor = mix(vec3<f32>(0.03), albedoLinear, g.metallic);
    
    // View and reflection directions
    let incident_dir = normalize(g.worldPos - camera.cameraPosition);
    g.reflectedDir = normalize(reflect(incident_dir, g.normal));
    g.viewDir = -incident_dir;
    
    return g;
}

// PBR helper functions
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH2 = NdotH * NdotH;
    
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    
    return num / denom;
}

fn Geometric_Smith_Schlick_GGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    
    let ggx2 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx1 = NdotL / (NdotL * (1.0 - k) + k);
    
    return ggx1 * ggx2;
}

fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn Specular(specularColor: vec3<f32>, h: vec3<f32>, v: vec3<f32>, l: vec3<f32>, a: f32, NdL: f32, NdV: f32, NdH: f32, VdH: f32, LdV: f32) -> vec3<f32> {
    let F0 = specularColor;
    
    // Cook-Torrance BRDF
    let NDF = NormalDistribution_GGX(NdH, a);
    let G = Geometric_Smith_Schlick_GGX(NdV, NdL, a);
    let F = Fresnel_Schlick(VdH, F0);
    
    let numerator = NDF * G * F;
    let denominator = 4.0 * NdV * NdL + 0.0001; // Prevent division by zero
    
    return numerator / denominator;
}

fn Diffuse(pAlbedo: vec3<f32>) -> vec3<f32> {
    return pAlbedo / PI;
}

fn shade(iPosition: vec2<f32>, use_shadows: bool, fix_shadows: bool, smooth_attenuation: bool) -> vec4<f32> {
    let g = decodeGBuffer(iPosition);
    
    // Shadow factor entre 0 (totalmente en sombra) y 1 (no ocluido)
    var shadow_factor = 1.0;
    if (use_shadows) {
        // shadow_factor = getShadowFactor(g.worldPos); // TODO: Implement shadow mapping
    }
    
    let worldPos = vec4<f32>(g.worldPos, 1.0);
    
    if (fix_shadows) {
        let almostScreenPos = light.viewProjOffset * worldPos;
        let screenPos = almostScreenPos.xyz / almostScreenPos.w;
        // if out of range, shadow_factor = 0
        if (screenPos.x < -1.0 || screenPos.x > 1.0 || screenPos.y < -1.0 || screenPos.y > 1.0) {
            shadow_factor = 0.0;
        }
    }
    /*
    if (fix_shadows || use_shadows) {
        let PosLightProjection = light.viewProjOffset * worldPos;
        let PosLightHomoSpace = PosLightProjection.xyz / PosLightProjection.w;
        
        let texture_color = textureSample(txProjector, samBorderColor, PosLightHomoSpace.xy);
        shadow_factor *= texture_color.x;
    }
    */
    
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
    var att = saturate(distance_to_light / light.radius);
    att = 1.0 - att;
    if(smooth_attenuation){
        // Physically-based attenuation (inverse square + smooth cutoff)
        let distance_attenuation = 1.0 / max(distance_to_light * distance_to_light, 0.01);
        let radius_attenuation = saturate(1.0 - pow(distance_to_light / light.radius, 4.0));
        att = distance_attenuation * radius_attenuation * radius_attenuation;
    }

    // Energy conservation: specular contribution reduces diffuse
    let final_color = light.color.xyz * NdL * (cDiff + cSpec) * att * light.intensity * shadow_factor;
    return vec4<f32>(final_color, 1.0);
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;

@fragment
fn PS_point_lights(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    return shade(pos, false, false, true);
}

@fragment
fn PS_dir_lights_no_shadow(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    return shade(pos, false, true, false);
}