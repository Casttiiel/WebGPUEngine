#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

/**
 * Cascaded Shadow Mapping (CSM) Shader
 * Implementa sombras con 3 cascadas para mejor calidad en diferentes rangos de distancia
 */

struct LightCSMUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    direction: vec3<f32>,
    intensity: f32,
    viewProjOffset0: mat4x4<f32>,  // Cascade 0 (near)
    viewProjOffset1: mat4x4<f32>,  // Cascade 1 (mid)
    viewProjOffset2: mat4x4<f32>,  // Cascade 2 (far)
    cascadeSplits: vec4<f32>,      // Far planes de cada cascada (x, y, z) + padding
    shadowParams: vec4<f32>,       // shadowStep, inverseRes, stepDivRes, padding
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> light: LightCSMUniforms;
@group(2) @binding(1) var gShadowMap0: texture_depth_2d; // Cascade 0
@group(2) @binding(2) var gShadowMap1: texture_depth_2d; // Cascade 1
@group(2) @binding(3) var gShadowMap2: texture_depth_2d; // Cascade 2
@group(2) @binding(4) var gShadowSampler: sampler_comparison;

/**
 * Selecciona la cascada apropiada basado en la profundidad en view space
 * Retorna: índice de cascada (0, 1, o 2)
 */
fn selectCascade(viewSpaceZ: f32) -> i32 {
    // viewSpaceZ es negativo en view space (cámara mira hacia -Z)
    let absDepth = abs(viewSpaceZ);
    
    if (absDepth < light.cascadeSplits.x) {
        return 0; // Cascade near
    } else if (absDepth < light.cascadeSplits.y) {
        return 1; // Cascade mid
    } else {
        return 2; // Cascade far
    }
}

/**
 * Calcula el shadow factor para CSM con selección de cascada
 */
fn getCSMShadowFactor(worldPos: vec3<f32>, viewSpaceZ: f32) -> f32 {
    let cascadeIndex = selectCascade(viewSpaceZ);
    let shadowStepDivRes = light.shadowParams.z;
    
    // Seleccionar shadow map y matriz según cascada
    // WGSL no permite variables de tipo texture, por lo que usamos llamadas separadas
    if (cascadeIndex == 0) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset0,
            shadowStepDivRes,
            gShadowMap0,
            gShadowSampler,
            false  // viewProjOffset ya incluye transformación UV
        );
    } else if (cascadeIndex == 1) {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset1,
            shadowStepDivRes,
            gShadowMap1,
            gShadowSampler,
            false  // viewProjOffset ya incluye transformación UV
        );
    } else {
        return getShadowFactor(
            worldPos,
            light.viewProjOffset2,
            shadowStepDivRes,
            gShadowMap2,
            gShadowSampler,
            false  // viewProjOffset ya incluye transformación UV
        );
    }
}

/**
 * Debug: Color por cascada para visualización
 */
fn getCascadeDebugColor(viewSpaceZ: f32) -> vec3<f32> {
    let cascadeIndex = selectCascade(viewSpaceZ);
    
    if (cascadeIndex == 0) {
        return vec3<f32>(1.0, 0.0, 0.0); // Rojo = near
    } else if (cascadeIndex == 1) {
        return vec3<f32>(0.0, 1.0, 0.0); // Verde = mid
    } else {
        return vec3<f32>(0.0, 0.0, 1.0); // Azul = far
    }
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    
    if(g.zlinear >= 1.0){
        discard;
    }

    // Calcular profundidad en view space
    let viewSpacePos = (camera.viewMatrix * vec4<f32>(g.worldPos, 1.0)).xyz;
    let viewSpaceZ = viewSpacePos.z;

    // Shadow factor con CSM
    var shadow_factor = 1.0;
    if (light.hasShadows > 0.5) {
        shadow_factor = getCSMShadowFactor(g.worldPos, viewSpaceZ);
    }

    let light_dir = normalize(light.direction);
    
    let NdL = saturate(dot(g.normal, light_dir));
    let NdV = saturate(dot(g.normal, g.viewDir));
    let h = normalize(light_dir + g.viewDir);
    
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);
    
    // PBR calculations
    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);
    
    // Energy conservation
    let F = Fresnel_Schlick(VdH, g.specularColor);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);
    
    let diffuse_contrib = kD * cDiff;
    let specular_contrib = cSpec;

    let final_color = light.color.xyz * NdL * (diffuse_contrib + specular_contrib) * light.intensity * shadow_factor;
    
    // Debug: Descomentar para verificar que la luz funciona sin sombras
    // return vec4<f32>(light.color.xyz * NdL * light.intensity, 1.0);
    
    // Debug: Descomentar para visualizar cascadas
    // return vec4<f32>(final_color * 0.5 + getCascadeDebugColor(viewSpaceZ) * 0.5, 1.0);
    
    return vec4<f32>(final_color, 1.0);
}
