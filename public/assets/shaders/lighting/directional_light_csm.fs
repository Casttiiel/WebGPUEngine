#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/lighting/csm"
#include "common/lighting/shadows"

// DEBUG: Cambia esto a true para ver colores de cascadas
const DEBUG_CASCADE_COLORS: bool = false;

// Use consolidated CSM struct
alias LightUniformsCSM = DirectionalLightCSMUniforms;

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> light: LightUniformsCSM;
@group(2) @binding(1) var gShadowMap0: texture_depth_2d; // Cascade 0 (near)
@group(2) @binding(2) var gShadowMap1: texture_depth_2d; // Cascade 1 (mid)
@group(2) @binding(3) var gShadowMap2: texture_depth_2d; // Cascade 2 (far)
@group(2) @binding(4) var gShadowSampler: sampler_comparison;
// Contact shadow factor [0,1]: 1.0 = lit, 0.0 = occluded
@group(2) @binding(5) var contactShadowMap:     texture_2d<f32>;
@group(2) @binding(6) var contactShadowSampler: sampler;

fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);
    if (cascadeIndex == 0) { return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false); }
    if (cascadeIndex == 1) { return getShadowFactor(worldPos, light.viewProjOffset1, light.shadowParams.y, gShadowMap1, gShadowSampler, false); }
    return getShadowFactor(worldPos, light.viewProjOffset2, light.shadowParams.z, gShadowMap2, gShadowSampler, false);
}

fn getShadowFactorForCascadeIndex(worldPos: vec3<f32>, idx: i32) -> f32 {
    if (idx == 0) { return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false); }
    if (idx == 1) { return getShadowFactor(worldPos, light.viewProjOffset1, light.shadowParams.y, gShadowMap1, gShadowSampler, false); }
    return getShadowFactor(worldPos, light.viewProjOffset2, light.shadowParams.z, gShadowMap2, gShadowSampler, false);
}

/**
 * Blended CSM.
 * Blend zone = 10% of each cascade distance (min 1 m), scales with far cascades.
 * Last cascade fades to fully lit (1.0) instead of hard-cutting.
 */
fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(light.cascadeSplits.w);

    if (cascadeCount == 1) {
        return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false);
    }

    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);

    var splitDist: f32;
    if      (cascadeIndex == 0) { splitDist = light.cascadeSplits.x; }
    else if (cascadeIndex == 1) { splitDist = light.cascadeSplits.y; }
    else                        { splitDist = light.cascadeSplits.z; }

    // 10% blend zone, minimum 1 m — scales naturally with each cascade reach
    let blendZone   = max(splitDist * 0.1, 1.0);
    let blendStart  = splitDist - blendZone;
    let blendFactor = saturate((viewSpaceDepth - blendStart) / blendZone);

    let shadow1 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex);
    if (blendFactor < 0.01) { return shadow1; }

    // Beyond the last cascade fade to unshadowed (1.0) instead of repeating cascade N
    var shadow2: f32;
    if (cascadeIndex >= cascadeCount - 1) {
        shadow2 = 1.0;
    } else {
        shadow2 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex + 1);
    }

    return mix(shadow1, shadow2, smoothstep(0.0, 1.0, blendFactor));
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    
    if (g.zlinear >= 1.0) {
        discard;
    }

    // Calcular distancia en view space para selección de cascada
    let viewSpaceDepth = g.zlinear * camera.cameraFar;
    
    // Determinar cascada usando función consolidada
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);
    
    var cascadeColor = vec3<f32>(1.0);
    // DEBUG: Mostrar colores de cascada si está activado
    if (DEBUG_CASCADE_COLORS) {
        cascadeColor = getCascadeDebugColorCSM(cascadeIndex);
        //return vec4<f32>(cascadeColor * g.albedo * 0.5 + cascadeColor * 0.5, 1.0);
    }
    
    // Shadow factor con CSM blending
    var shadow_factor = 1.0;
    let light_dir = normalize(light.position);
    
    if (light.hasShadows > 0.5) {
        shadow_factor = getShadowFactorCSMBlended(g.worldPos, viewSpaceDepth);
    }
    
    // PBR calculations
    let NdL = max(dot(g.normal, light_dir), 0.0); // No minimum lighting on back faces
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    if (NdL <= 0.0 || NdV <= 0.0) {
        return vec4<f32>(0.0);
    }
    let h = normalize(light_dir + g.viewDir);
    
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);
    
    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);
    
    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);
    
    let diffuse_contrib = kD * cDiff;
    let specular_contrib = cSpec;

    let hl = halfLambert(NdL);
    let final_color = light.color.xyz * (diffuse_contrib * hl + specular_contrib * NdL) * light.intensity * shadow_factor;

    // Apply contact shadow factor (1.0 = lit, 0.0 = occluded)
    let contactFactor = textureSampleLevel(contactShadowMap, contactShadowSampler, uv, 0.0).r;
    return vec4<f32>(final_color * cascadeColor * contactFactor, 1.0);
}
