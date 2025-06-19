#include "common/uniforms"
#include "common/structs"
#include "common/utils"

// Constantes SSAO
const SAMPLE_COUNT = 16u;
const RADIUS = 0.2;           // Radio en unidades de mundo (reducido para mayor detalle)
const BIAS = 0.001;          // Para evitar self-occlusion (reducido para detectar mejor las oclusiones)
const AO_STRENGTH = 3.0;      // Intensidad del efecto (aumentado para mejor contraste)
const MAX_DISTANCE = 0.3;     // Distancia máxima de consideración (reducida para oclusión más local)

// Generación de ruido procedural
fn hash(p: vec2<f32>) -> vec2<f32> {
    let p2 = vec2<f32>(
        dot(p, vec2<f32>(127.1, 311.7)),
        dot(p, vec2<f32>(269.5, 183.3))
    );
    return fract(sin(p2) * 43758.5453123);
}

// Generación de vector hemisférico para sample
fn hemispherePoint(seed: vec2<f32>, n: vec3<f32>) -> vec3<f32> {
    let noise = hash(seed);
    let theta = noise.x * 2.0 * 3.14159;
    let r = sqrt(noise.y);
    
    // Crear vector en hemisferio
    let v = vec3<f32>(
        r * cos(theta),
        r * sin(theta),
        sqrt(1.0 - noise.y)
    );
    
    // Orientar hacia la normal
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.999);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    
    return tangent * v.x + bitangent * v.y + n * v.z;
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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;


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


fn samplePosition(centerPos: vec3<f32>, normal: vec3<f32>, screenPos: vec2<f32>, index: u32) -> vec2<f32> {
    let sampleVec = hemispherePoint(screenPos + vec2<f32>(f32(index) * 0.0713, f32(index) * 0.4271), normal);
    let samplePos = centerPos + sampleVec * RADIUS;
    let sampleNDC = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(samplePos, 1.0);
    return clamp((sampleNDC.xy / sampleNDC.w) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
}

fn calculateAO(g: GBuffer, uv: vec2<f32>) -> f32 {
    var occlusion = 0.0;
    let pixelPos = g.worldPos;
    let normal = g.normal;
    let screenPos = uv * camera.screenSize;
    
    // Calculamos y acumulamos la oclusión para todas las muestras
    for (var i = 0u; i < SAMPLE_COUNT; i = i + 1u) {
        let sampleUV = samplePosition(pixelPos, normal, screenPos, i);
        let sampleDepth = textureSample(gLinearDepth, samplerGBuffer, sampleUV).x;
        
        // Cálculos de oclusión
        let sampleWorldPos = getWorldCoords(sampleUV, sampleDepth, camera);
        let distVec = sampleWorldPos - pixelPos;
        let dist = length(distVec);
        
        // Factores de peso
        let distScale = 1.0 - smoothstep(0.0, MAX_DISTANCE, dist);
        let distToSurface = g.zlinear - sampleDepth;
        let normalFactor = max(dot(normal, normalize(distVec)), 0.0);
        
        // Acumular oclusión pesada
        let contribution = normalFactor * distScale;
        occlusion += contribution * f32(distToSurface > BIAS && distToSurface < MAX_DISTANCE);
    }
    
    // Normalizar y aplicar contraste
    occlusion = (occlusion / f32(SAMPLE_COUNT)) * AO_STRENGTH;
    return clamp(1.0 - occlusion, 0.0, 1.0);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    // Decode GBuffer data
    let g = decodeGBuffer(uv);
    
    // Calculate ambient occlusion
    let ao = calculateAO(g, uv);
    
    // Blend between AO and fully lit based on depth
    let backgroundFactor = smoothstep(0.9995, 0.9999, g.zlinear);
    let finalAO = mix(pow(ao, 1.5), 1.0, backgroundFactor);
    
    // Output AO value (1.0 = fully lit, 0.0 = fully occluded)
    return finalAO;
}