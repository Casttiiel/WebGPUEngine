#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

// DEBUG: Cambia esto a true para ver colores de cascadas
const DEBUG_CASCADE_COLORS: bool = false;

struct LightUniformsCSM {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>, // Direction towards light
    intensity: f32,
    viewProjOffset0: mat4x4<f32>, // Cascade 0 (near)
    viewProjOffset1: mat4x4<f32>, // Cascade 1 (mid)
    viewProjOffset2: mat4x4<f32>, // Cascade 2 (far)
    cascadeSplits: vec4<f32>,     // x: split0, y: split1, z: split2, w: cascadeCount
    shadowParams: vec4<f32>,      // x: shadowStep, y: invResolution, z: stepDivResolution, w: unused
}

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
 * Selecciona la cascada apropiada basándose en la distancia al fragmento.
 * Retorna: índice de cascada (0, 1, o 2)
 */
fn selectCascade(viewSpaceDepth: f32) -> i32 {
    let cascadeCount = i32(light.cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return 0;
    }
    
    if (viewSpaceDepth < light.cascadeSplits.x) {
        return 0; // Near cascade
    } else if (cascadeCount == 2 || viewSpaceDepth < light.cascadeSplits.y) {
        return min(1, cascadeCount - 1); // Mid cascade
    } else {
        return min(2, cascadeCount - 1); // Far cascade
    }
}

/**
 * Calcula el shadow factor con la cascada seleccionada.
 * Las texturas no pueden ser variables en WGSL, se llama directamente.
 */
fn getShadowFactorCSM(worldPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    // Seleccionar cascada
    let cascadeIndex = selectCascade(viewSpaceDepth);
    
    // Llamar a getShadowFactor con la cascada apropiada + cascadeIndex para PCF adaptativo
    if (cascadeIndex == 0) {
        return getShadowFactor(
            worldPos,
            normal,
            lightDir,
            light.viewProjOffset0,
            light.shadowParams.z,
            gShadowMap0,
            gShadowSampler,
            false,
            0 // Cascada 0: 16 samples
        );
    } else if (cascadeIndex == 1) {
        return getShadowFactor(
            worldPos,
            normal,
            lightDir,
            light.viewProjOffset1,
            light.shadowParams.z,
            gShadowMap1,
            gShadowSampler,
            false,
            1 // Cascada 1: 9 samples
        );
    } else {
        return getShadowFactor(
            worldPos,
            normal,
            lightDir,
            light.viewProjOffset2,
            light.shadowParams.z,
            gShadowMap2,
            gShadowSampler,
            false,
            2 // Cascada 2: 4 samples
        );
    }
}

/**
 * Calcula el shadow factor con blend entre cascadas para transiciones suaves.
 */
fn getShadowFactorCSMBlended(worldPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(light.cascadeSplits.w);
    
    // Si solo hay 1 cascada, no hay blend
    if (cascadeCount == 1) {
        return getShadowFactor(
            worldPos,
            normal,
            lightDir,
            light.viewProjOffset0,
            light.shadowParams.z,
            gShadowMap0,
            gShadowSampler,
            false,
            0 // Cascada 0
        );
    }
    
    // Región de blend (10% alrededor del split)
    let blendRegion = 0.1;
    
    // Determinar cascadas y factor de blend
    var cascadeIndex = selectCascade(viewSpaceDepth);
    var blendFactor = 0.0;
    
    // Calcular blend factor si estamos cerca de un split
    if (cascadeIndex == 0 && viewSpaceDepth > light.cascadeSplits.x * (1.0 - blendRegion)) {
        let splitDist = light.cascadeSplits.x;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    } else if (cascadeIndex == 1 && cascadeCount > 2 && viewSpaceDepth > light.cascadeSplits.y * (1.0 - blendRegion)) {
        let splitDist = light.cascadeSplits.y;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    }
    
    // Si no hay blend, retornar shadow factor simple
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, normal, lightDir, viewSpaceDepth);
    }
    
    // Calcular shadow factor de ambas cascadas
    let shadowFactor1 = getShadowFactorCSM(worldPos, normal, lightDir, viewSpaceDepth);
    
    // Forzar siguiente cascada
    let nextCascadeDepth = viewSpaceDepth + 0.1;
    let shadowFactor2 = getShadowFactorCSM(worldPos, normal, lightDir, nextCascadeDepth);
    
    // Blend suave entre cascadas
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

/**
 * Retorna el color de debug para cada cascada:
 * - Cascada 0 (cerca): Rojo
 * - Cascada 1 (media): Verde  
 * - Cascada 2 (lejos): Azul
 */
fn getCascadeDebugColor(cascadeIndex: i32) -> vec3<f32> {
    if (cascadeIndex == 0) {
        return vec3<f32>(1.0, 0.0, 0.0); // Rojo
    } else if (cascadeIndex == 1) {
        return vec3<f32>(0.0, 1.0, 0.0); // Verde
    } else {
        return vec3<f32>(0.0, 0.0, 1.0); // Azul
    }
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    
    if (g.zlinear >= 1.0) {
        discard;
    }

    // Calcular distancia en view space para selección de cascada
    let camToFragment = g.worldPos - camera.cameraPosition;
    let viewSpaceDepth = length(camToFragment);
    
    // Determinar cascada
    let cascadeIndex = selectCascade(viewSpaceDepth);
    
    var cascadeColor = vec3<f32>(1.0);
    // DEBUG: Mostrar colores de cascada si está activado
    if (DEBUG_CASCADE_COLORS) {
        cascadeColor = getCascadeDebugColor(cascadeIndex);
        //return vec4<f32>(cascadeColor * g.albedo * 0.5 + cascadeColor * 0.5, 1.0);
    }
    
    // Shadow factor con CSM blending
    var shadow_factor = 1.0;
    let light_dir = normalize(light.position);
    
    if (light.hasShadows > 0.5) {
        shadow_factor = getShadowFactorCSMBlended(g.worldPos, g.normal, light_dir, viewSpaceDepth);
    }
    
    // PBR calculations
    let NdL = max(saturate(dot(g.normal, light_dir)), 0.05);
    let NdV = max(saturate(dot(g.normal, g.viewDir)), 0.05);
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
