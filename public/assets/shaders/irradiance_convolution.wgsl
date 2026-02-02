// Irradiance Convolution Compute Shader
// Genera un irradiance cubemap a partir de un environment cubemap
// Usa integración Monte Carlo sobre el hemisferio con muestreo coseno-ponderado

#include "common/ibl/sampling"
#include "common/ibl/cubemap"

const SAMPLE_COUNT: u32 = 1024u; // Número de muestras por píxel

@group(0) @binding(0) var inputCubemap: texture_cube<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var outputTexture: texture_storage_2d_array<rgba16float, write>;

struct PushConstants {
    face: u32,           // Cara del cubemap (0-5)
    outputSize: u32,     // Tamaño de salida (típicamente 32 o 64)
}

@group(0) @binding(3) var<uniform> constants: PushConstants;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let outputSize = constants.outputSize;
    let face = constants.face;
    
    // Verificar límites
    if (global_id.x >= outputSize || global_id.y >= outputSize) {
        return;
    }
    
    // Convertir coordenadas de píxel a UV [0, 1]
    let uv = (vec2<f32>(global_id.xy) + 0.5) / f32(outputSize);
    
    // Obtener dirección de la normal para este píxel
    let normal = uvToDirection(uv, face);
    
    // Generar base ortonormal
    let TBN = generateTBN(normal);
    
    // Acumular irradiancia con ponderación por luminancia
    var irradiance = vec3<f32>(0.0);
    var totalWeight = 0.0;
    
    // Integración Monte Carlo con ponderación
    for (var i = 0u; i < SAMPLE_COUNT; i++) {
        let xi = hammersley(i, SAMPLE_COUNT);
        let sampleDir_tangent = importanceSampleCosine(xi);
        let sampleDir = TBN * sampleDir_tangent;
        
        // Muestrear el cubemap de entrada
        let color = textureSampleLevel(inputCubemap, inputSampler, sampleDir, 0.0).rgb;
        
        // ✅ Ponderar por luminancia inversa para reducir influencia del cielo brillante
        // Esto evita que el skybox azul domine el promedio
        let luminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
        let weight = 1.0 / (1.0 + luminance * 0.5); // Factor 0.5 para suavizar el efecto
        
        // Acumular con peso
        irradiance += color * weight;
        totalWeight += weight;
    }
    
    // Promediar con el peso total acumulado
    irradiance /= totalWeight;
    
    // Escribir resultado
    textureStore(
        outputTexture,
        vec2<i32>(global_id.xy),
        i32(face),
        vec4<f32>(irradiance, 1.0)
    );
}
