#include "common/uniforms"

struct DOFUniforms {
    focus_distance: f32,
    aperture: f32,
    focal_length: f32,
    sensor_height: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// DOF Parameters
@group(2) @binding(0) var<uniform> dofParams: DOFUniforms;

// Calcula Circle of Confusion usando ecuación física de lente
fn calculateCoC(worldDepth: f32) -> f32 {
    let subjectDistance = worldDepth;
    let focusDistance = dofParams.focus_distance;
    
    // Evitar división por cero
    if (abs(subjectDistance - focusDistance) < 0.01) {
        return 0.0; // In focus
    }
    
    // Ecuación física de la lente:
    // CoC = (A * F * |S - D|) / (S * (D - F))
    // A = aperture diameter = focal_length / f_stop
    // F = focal_length
    // S = subject_distance
    // D = focus_distance
    
    let apertureDiameter = dofParams.focal_length / dofParams.aperture;
    let numerator = apertureDiameter * dofParams.focal_length * abs(subjectDistance - focusDistance);
    let denominator = subjectDistance * max(focusDistance - dofParams.focal_length, 0.001);
    
    let cocMM = numerator / denominator; // CoC en milímetros
    
    // Convertir a píxeles (normalizado por altura del sensor)
    let resolution = vec2<f32>(textureDimensions(gLinearDepth));
    let cocPixels = (cocMM / dofParams.sensor_height) * resolution.y;
    
    // Signo indica near (-) o far (+)
    let sign = sign(subjectDistance - focusDistance);
    
    return clamp(cocPixels * sign, -50.0, 50.0); // Limitar a ±50px
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    
    // Detectar skybox (depth = 1.0) → CoC = 0 (siempre enfocado)
    if (linearDepth >= 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    
    let worldDepth = linearDepth * camera.cameraZFar;
    let coc = calculateCoC(worldDepth);
    
    // Separar near/far para optimizaciones
    let nearCoC = max(-coc, 0.0); // Solo valores negativos (foreground)
    let farCoC = max(coc, 0.0);   // Solo valores positivos (background)
    
    // R: Far CoC, G: Near CoC, B: Full CoC (signed), A: unused
    return vec4<f32>(farCoC, nearCoC, coc, 1.0);
}
