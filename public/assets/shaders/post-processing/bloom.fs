#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

// Estructura para parámetros de bloom
struct BloomParams {
    threshold: f32,         // Umbral de brillo
    softKnee: f32,          // Factor de transición suave
    emissive_factor: f32,   // Factor para emisivos
    padding: f32,           // Para alineación
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;
@group(2) @binding(0) var accLights: texture_2d<f32>;
@group(2) @binding(1) var accLightsSampler: sampler;

// Uniform buffer para parámetros de bloom
@group(3) @binding(0) var<uniform> bloomParams: BloomParams;

@fragment
fn PS_filter(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let color = textureSample(accLights, accLightsSampler, uv).rgb;

    // Luminancia perceptual
    let luminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    let emissive_contribution = g.emissive / bloomParams.emissive_factor;
    let total_brightness = luminance + emissive_contribution;

    // Unity-style bloom filter
    let threshold = bloomParams.threshold;
    let knee = threshold * bloomParams.softKnee;

    let soft = total_brightness - threshold + knee;
    let clamped_soft = clamp(soft, 0.0, 2.0 * knee);
    let soft_val = clamped_soft * clamped_soft / (4.0 * knee + 1e-4);

    let contribution = max(soft_val, total_brightness - threshold);
    let bright = color * contribution / max(total_brightness, 1e-4);

    return vec4<f32>(bright, 1.0);
}