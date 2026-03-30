#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"

// Constantes para bilateral filter
const BILATERAL_RADIUS = 3u;      // Radio del filtro bilateral
const BILATERAL_SIGMA_DEPTH = 0.01; // Sensibilidad a diferencias de profundidad
const BILATERAL_SIGMA_NORMAL = 0.5; // Sensibilidad a diferencias de normales

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures para información de geometría (usando layout estándar)
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;        // No se usa pero está en el layout
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// AO texture sin filtrar (input)
@group(2) @binding(0) var aoTexture: texture_2d<f32>;
@group(2) @binding(1) var samplerAO: sampler;

// Bilateral filter para suavizar AO manteniendo bordes
fn bilateralFilter(centerUV: vec2<f32>) -> f32 {
    var filteredAO = 0.0;
    var totalWeight = 0.0;
    let texelSize = 1.0 / camera.screenSize;
      // Obtener datos del pixel central
    let centerDepth = textureSample(gLinearDepth, samplerGBuffer, centerUV).x;
    
    if(centerDepth > 0.99) {
        return 1.0; // Early exit for sky
    }

    let normalRoughnessData = textureSampleLevel(gNormals, samplerGBuffer, centerUV, 0.0);
    let centerNormal = octahedral01ToNormal(normalRoughnessData.xy);
    let centerAO = textureSampleLevel(aoTexture, samplerAO, centerUV, 0.0).b;
    
    // Muestrear en un patrón 5x5 alrededor del pixel central
    for (var x = -i32(BILATERAL_RADIUS); x <= i32(BILATERAL_RADIUS); x++) {
        for (var y = -i32(BILATERAL_RADIUS); y <= i32(BILATERAL_RADIUS); y++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let sampleUV = clamp(centerUV + offset, vec2<f32>(0.0), vec2<f32>(1.0));
            
            // Obtener datos de la muestra
            let sampleDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, sampleUV, 0.0).x;
            let normalRoughnessData2 = textureSampleLevel(gNormals, samplerGBuffer, sampleUV, 0.0);
            let sampleNormal = octahedral01ToNormal(normalRoughnessData2.xy);
            let sampleAO = textureSampleLevel(aoTexture, samplerAO, sampleUV, 0.0).b;
            
            // Calcular pesos basados en similitud de profundidad y normal
            let depthDiff = abs(centerDepth - sampleDepth);
            let normalDiff = 1.0 - max(dot(centerNormal, sampleNormal), 0.0);
            
            // Pesos gaussianos espaciales
            let spatialWeight = exp(-(f32(x * x + y * y)) / (2.0 * f32(BILATERAL_RADIUS) * f32(BILATERAL_RADIUS)));
            
            // Pesos basados en similitud de características
            let depthWeight = exp(-depthDiff / BILATERAL_SIGMA_DEPTH);
            let normalWeight = exp(-normalDiff / BILATERAL_SIGMA_NORMAL);
            
            // Peso total combinado
            let weight = spatialWeight * depthWeight * normalWeight;
            
            filteredAO += sampleAO * weight;
            totalWeight += weight;
        }
    }
    
    // Normalizar por el peso total o usar valor original
    return select(centerAO, filteredAO / totalWeight, totalWeight > 0.0);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    // Apply bilateral filter to the AO texture
    let filteredAO = bilateralFilter(uv);
    // Output filtered AO value
    return filteredAO;
}
