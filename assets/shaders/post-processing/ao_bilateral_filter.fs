struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
}

struct VertexOutputTriplanarLocal {
    @builtin(position) position: vec4<f32>,

    @location(0) @interpolate(perspective, centroid) localNormal: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) localPos: vec3<f32>,
    @location(2) @interpolate(perspective, centroid) worldPos: vec3<f32>,

    // Normal matrix como 3 columnas (col0, col1, col2)
    @location(3) @interpolate(perspective, centroid) normalMatrix0: vec3<f32>,
    @location(4) @interpolate(perspective, centroid) normalMatrix1: vec3<f32>,
    @location(5) @interpolate(perspective, centroid) normalMatrix2: vec3<f32>,
}

struct ShadowsVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) worldPos: vec3<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
    @location(1) normal: vec4<f32>,     // RG: octahedral normal, BA: roughness + emissive
    @location(2) depth: f32,      // Linear depth (view space)
}

struct GBuffer {
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    specularColor: vec3<f32>,
    roughness: f32,
    selfIllum: vec3<f32>,
    emissive: f32,
    reflectedDir: vec3<f32>,
    viewDir: vec3<f32>,
    metallic: f32,
    zlinear: f32,
}

struct MaterialFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,  // decal: blend weight for albedo+normal (1=full, 0=no change)
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,     // decal: blend weight for roughness+metallic (1=full, 0=no change)
    pomScale: f32          // POM height scale (0 = disabled, typical 0.01-0.1)
}

struct SSRUniforms {
    globalAmbientBoost: f32,
    stepSize: f32,
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    specularBoost: f32,
    diffuseBoost: f32,
    metallicMin: f32,
    roughnessMax: f32,
    temporalMode: f32,  // 1.0 = TAA active (halve march steps), 0.0 = standalone
    frameIndex: f32,    // incremented each frame — drives blue-noise temporal animation
}
fn sign_nonzero_f(v: f32) -> f32 {
    return select(-1.0, 1.0, v >= 0.0);
}



fn encodeOctahedral(n: vec3<f32>) -> vec2<f32> {
    // Proyección octahedral: divide por la norma L1
    var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    // Wrap para hemisferio negativo Z
    if (n.z < 0.0) {
        p = (1.0 - abs(p.yx)) * sign_nonzero(p);
    }
    return p;  // rango [-1, 1]
}

fn decodeOctahedral(p: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    if (n.z < 0.0) {
        let tmp = n.xy;
        n.x = (1.0 - abs(tmp.y)) * sign_nonzero_f(tmp.x);
        n.y = (1.0 - abs(tmp.x)) * sign_nonzero_f(tmp.y);
    }
    return normalize(n);
}

// sign que devuelve +1 cuando x=0 (necesario para el wrap)
fn sign_nonzero(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0)
    );
}

fn normalToOctahedral01(n: vec3<f32>) -> vec2<f32> {
    return encodeOctahedral(n) * 0.5 + 0.5;
}

fn octahedral01ToNormal(enc: vec2<f32>) -> vec3<f32> {
    return decodeOctahedral(enc * 2.0 - 1.0);
}

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
