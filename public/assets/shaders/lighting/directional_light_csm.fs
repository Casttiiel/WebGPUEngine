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

/**
 * Shader-specific implementation using consolidated CSM functions.
 * Selects appropriate shadow map based on cascade index.
 */
fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);
    
    // Call getShadowFactor with appropriate cascade shadow map
    if (cascadeIndex == 0) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset0, light.shadowParams.z,
            gShadowMap0, gShadowSampler, false
        );
    } else if (cascadeIndex == 1) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset1, light.shadowParams.z,
            gShadowMap1, gShadowSampler, false
        );
    } else {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset2, light.shadowParams.z,
            gShadowMap2, gShadowSampler, false
        );
    }
}

fn getShadowFactorForCascadeIndex(worldPos: vec3<f32>, idx: i32) -> f32 {    
    // Call getShadowFactor with appropriate cascade shadow map
    if (idx == 0) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset0, light.shadowParams.z,
            gShadowMap0, gShadowSampler, false
        );
    } else if (idx == 1) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset1, light.shadowParams.z,
            gShadowMap1, gShadowSampler, false
        );
    } else {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset2, light.shadowParams.z,
            gShadowMap2, gShadowSampler, false
        );
    }
}

/**
 * Shader-specific blended CSM using consolidated functions.
 */
fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(light.cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset0, light.shadowParams.z,
            gShadowMap0, gShadowSampler, false
        );
    }
    
    let blendRegion = 0.1;
    var cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);
    var blendFactor = 0.0;
    
    if (cascadeIndex == 0 && viewSpaceDepth > light.cascadeSplits.x * (1.0 - blendRegion)) {
        let splitDist = light.cascadeSplits.x;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    } else if (cascadeIndex == 1 && cascadeCount > 2 && viewSpaceDepth > light.cascadeSplits.y * (1.0 - blendRegion)) {
        let splitDist = light.cascadeSplits.y;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    }
    
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, viewSpaceDepth);
    }
    
    let shadowFactor1 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex);
    let shadowFactor2 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex + 1);
    
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    
    if (g.zlinear >= 1.0) {
        discard;
    }

    // Calcular distancia en view space para selección de cascada
    let viewSpaceDepth = abs((camera.viewMatrix * vec4(g.worldPos,1)).z);
    
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

    let final_color = light.color.xyz * NdL * (diffuse_contrib + specular_contrib) * light.intensity * shadow_factor;
    
    return vec4<f32>(final_color * cascadeColor, 1.0);
}
