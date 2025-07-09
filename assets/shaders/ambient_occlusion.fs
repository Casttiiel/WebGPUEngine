#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/gbuffer"

// Estructura para parámetros SSAO solamente
struct SSAOParams {
    sampleCount: f32,
    radius: f32,
    bias: f32,
    aoStrength: f32,
    maxDistance: f32,
    noiseScale: f32,
}

// Pre-computed Poisson disk samples para mejor distribución
const POISSON_SAMPLES = array<vec2<f32>, 16>(
    vec2<f32>(-0.5119625f, -0.4827938f),
    vec2<f32>(-0.2171264f, -0.4768726f),
    vec2<f32>(-0.7552931f, -0.2426507f),
    vec2<f32>(-0.7136765f, 0.1735522f),
    vec2<f32>(-0.5019965f, -0.1767688f),
    vec2<f32>(-0.5312779f, 0.1921148f),
    vec2<f32>(-0.3753618f, 0.4054451f),
    vec2<f32>(-0.1565506f, 0.7612801f),
    vec2<f32>(0.0033669f, -0.7118613f),
    vec2<f32>(0.0920513f, -0.3131883f),
    vec2<f32>(0.1851896f, 0.1624865f),
    vec2<f32>(0.2829556f, -0.0987928f),
    vec2<f32>(0.5198096f, 0.1897564f),
    vec2<f32>(0.6253080f, -0.2991339f),
    vec2<f32>(0.3852080f, 0.5509507f),
    vec2<f32>(0.7672689f, 0.1565740f)
);

// Generación de ruido procedural mejorado
fn hash(p: vec2<f32>) -> vec2<f32> {
    let p2 = vec2<f32>(
        dot(p, vec2<f32>(127.1, 311.7)),
        dot(p, vec2<f32>(269.5, 183.3))
    );
    return fract(sin(p2) * 43758.5453123);
}

// Generación de vector hemisférico con Poisson disk mejorado
fn hemispherePointPoisson(index: u32, n: vec3<f32>, noise: vec2<f32>) -> vec3<f32> {
    // Usar muestras pre-computadas de Poisson disk
    let poissonSample = POISSON_SAMPLES[index];
    
    // Rotar la muestra con el ruido para reducir patrones
    let angle = noise.x * 2.0 * 3.14159;
    let cosAngle = cos(angle);
    let sinAngle = sin(angle);
    let rotatedSample = vec2<f32>(
        poissonSample.x * cosAngle - poissonSample.y * sinAngle,
        poissonSample.x * sinAngle + poissonSample.y * cosAngle
    );
    
    // Convertir a 3D hemisférico
    let r = sqrt(rotatedSample.x * rotatedSample.x + rotatedSample.y * rotatedSample.y);
    let theta = atan2(rotatedSample.y, rotatedSample.x);
    let phi = acos(sqrt(1.0 - r * r));
    
    let x = sin(phi) * cos(theta);
    let y = sin(phi) * sin(theta);
    let z = cos(phi);
    
    // Orientar hacia la normal usando TBN matrix
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.999);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    
    return normalize(tangent * x + bitangent * y + n * z);
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

// Uniform buffer para parámetros SSAO
@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;

fn samplePosition(centerPos: vec3<f32>, normal: vec3<f32>, screenPos: vec2<f32>, index: u32) -> vec2<f32> {
    // Usar Poisson disk con ruido rotacional
    let noise = hash(screenPos * ssaoParams.noiseScale);
    let sampleVec = hemispherePointPoisson(index, normal, noise);
    
    // Trabajar en espacio de vista en lugar de mundo
    let viewPos = (camera.viewMatrix * vec4<f32>(centerPos, 1.0)).xyz;
    let viewNormal = normalize((camera.viewMatrix * vec4<f32>(normal, 0.0)).xyz);
    let viewSampleVec = normalize((camera.viewMatrix * vec4<f32>(sampleVec, 0.0)).xyz);
    
    // Escalar el radio según la profundidad (más cerca = radio más pequeño)
    let depthScale = clamp(-viewPos.z / 10.0, 0.1, 1.0);
    let samplePosView = viewPos + viewSampleVec * ssaoParams.radius * depthScale;
    
    // Proyectar a espacio de pantalla
    let sampleNDC = camera.projectionMatrix * vec4<f32>(samplePosView, 1.0);
    let screenUV = (sampleNDC.xy / sampleNDC.w) * 0.5 + 0.5;
    
    // Asegurar que las coordenadas están en rango válido
    return clamp(screenUV, vec2<f32>(0.001), vec2<f32>(0.999));
}


fn calculateAORaw(g: GBuffer, uv: vec2<f32>) -> f32 {
    var occlusion = 0.0;
    let pixelPos = g.worldPos;
    let normal = g.normal;
    let screenPos = uv * camera.screenSize;
    
    // Use conditional multiplier instead of early exit for background pixels
    let backgroundFactor = f32(g.zlinear <= 0.999);
    
    // Convertir a espacio de vista para cálculos independientes de zFar
    let viewPos = (camera.viewMatrix * vec4<f32>(pixelPos, 1.0)).xyz;
    let viewNormal = normalize((camera.viewMatrix * vec4<f32>(normal, 0.0)).xyz);
    
    // Optimize sample count based on distance (LOD) - pero mantener uniforme
    let sampleCountFloat = ssaoParams.sampleCount;
    let distanceToCamera = length(viewPos);
    let lodFactor = clamp(distanceToCamera / 20.0, 0.25, 1.0); // Reduce samples for distant objects
    let actualSampleCount = u32(sampleCountFloat); // Keep uniform for now, apply LOD via contribution weight
    
    // Calculamos y acumulamos la oclusión para todas las muestras
    for (var i = 0u; i < 1; i = i + 1u) {
        var sampleUV = samplePosition(pixelPos, normal, screenPos, i);
        sampleUV.y = 1.0 - sampleUV.y; // Invertir Y para coordenadas de textura
        let sampleDepth = textureSample(gLinearDepth, samplerGBuffer, sampleUV).x;
        
        // Use conditional assignments instead of early returns to maintain uniform control flow
        let validDepth = f32(sampleDepth > 0.0 && sampleDepth < 1.0);
        
        // Cálculos de oclusión en espacio de vista (optimized)
        let sampleWorldPos = getWorldCoords(sampleUV, sampleDepth, camera);
        let sampleViewPos = (camera.viewMatrix * vec4<f32>(sampleWorldPos, 1.0)).xyz;
        
        let distVec = sampleViewPos - viewPos;
        let dist = length(distVec);
        
        // Use conditional instead of early exit
        let validDistance = f32(dist <= ssaoParams.maxDistance);
        
        // Optimized occlusion calculation
        let viewDepthDiff = sampleViewPos.z - viewPos.z;
        let adaptiveBias = ssaoParams.bias * (1.0 + dist);
        
        let validOcclusion = f32(viewDepthDiff > adaptiveBias);
        let normalFactor = max(dot(viewNormal, normalize(distVec)), 0.0);
        let distScale = 1.0 - (dist / ssaoParams.maxDistance);
        
        // Combine all validity checks into a single multiplier, apply LOD factor and background factor
        let contribution = normalFactor * distScale * validDepth * validDistance * validOcclusion * lodFactor * backgroundFactor;
        occlusion += contribution;
    }
  
    // Normalizar y aplicar contraste
    occlusion = (occlusion / f32(actualSampleCount)) * ssaoParams.aoStrength;
    return clamp(1.0 - occlusion, 0.0, 1.0);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    // Decode GBuffer data
    let g = decodeGBuffer(uv);
    
    // Calculate raw ambient occlusion only (no bilateral filter)
    let rawAO = calculateAORaw(g, uv);
    
    // Apply background blend using conditional multiplier instead of mix
    let backgroundFactor = smoothstep(0.9995, 0.9999, g.zlinear);
    let finalAO = rawAO * (1.0 - backgroundFactor) + backgroundFactor;
    
    // Apply power function for contrast
    let contrastedAO = pow(finalAO, 1.5);

    // Output final AO value (bilateral filter will be applied in separate pass)
    return contrastedAO;
}