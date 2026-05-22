// Irradiance Convolution Compute Shader
// Genera un irradiance cubemap a partir de un environment cubemap
// Usa integración Monte Carlo sobre el hemisferio con muestreo coseno-ponderado

// IBL Importance Sampling Functions
// Funciones de muestreo para Image-Based Lighting

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;


// Van der Corput sequence - genera secuencia pseudo-aleatoria de baja discrepancia
fn radicalInverseVdC(bits_in: u32) -> f32 {
    var bits = bits_in;
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return f32(bits) * 2.3283064365386963e-10; // / 0x100000000
}

// Hammersley sequence - secuencia quasi-aleatoria 2D de baja discrepancia
fn hammersley(i: u32, N: u32) -> vec2<f32> {
    return vec2<f32>(f32(i) / f32(N), radicalInverseVdC(i));
}

// Importance sampling cosine-weighted hemisphere
// Usado para irradiance convolution (difusa)
fn importanceSampleCosine(xi: vec2<f32>) -> vec3<f32> {
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt(1.0 - xi.y);
    let sinTheta = sqrt(xi.y);
    
    return vec3<f32>(
        cos(phi) * sinTheta,
        sin(phi) * sinTheta,
        cosTheta
    );
}

// Importance sampling GGX distribution
// Usado para specular IBL (pre-filtered environment maps)
fn importanceSampleGGX(xi: vec2<f32>, roughness: f32) -> vec3<f32> {
    let a = roughness * roughness;
    let a2 = a * a;
    
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    
    // Spherical to cartesian coordinates
    return vec3<f32>(
        cos(phi) * sinTheta,
        sin(phi) * sinTheta,
        cosTheta
    );
}

// Cubemap utilities for IBL and environment mapping
// Level 0: No dependencies

// Convert UV coordinates and face index to 3D direction
fn uvToDirection(uv: vec2<f32>, face: u32) -> vec3<f32> {
    let u = uv.x * 2.0 - 1.0; // [-1, 1]
    let v = uv.y * 2.0 - 1.0; // [-1, 1]
    
    var dir: vec3<f32>;
    
    switch face {
        case 0u: { dir = vec3<f32>(1.0, -v, -u); }   // +X
        case 1u: { dir = vec3<f32>(-1.0, -v, u); }   // -X
        case 2u: { dir = vec3<f32>(u, 1.0, v); }     // +Y
        case 3u: { dir = vec3<f32>(u, -1.0, -v); }   // -Y
        case 4u: { dir = vec3<f32>(u, -v, 1.0); }    // +Z
        default: { dir = vec3<f32>(-u, -v, -1.0); }  // -Z
    }
    
    return normalize(dir);
}

// Generate orthonormal basis (TBN matrix) from normal vector
fn generateTBN(normal: vec3<f32>) -> mat3x3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(normal.y) > 0.999) {
        up = vec3<f32>(1.0, 0.0, 0.0);
    }
    
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    
    return mat3x3<f32>(tangent, bitangent, normal);
}


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
