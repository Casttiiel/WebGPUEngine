#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/gbuffer"

// Estructura para parámetros de bloom
struct BloomParams {
    threshold_min: f32,
    threshold_max: f32, 
    emissive_factor: f32,
    padding: f32, // Para alineación de 16 bytes
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;
@group(2) @binding(0) var accLights: texture_2d<f32>;
@group(2) @binding(1) var accLightsSampler: sampler;

// Uniform buffer para parámetros de bloom
@group(3) @binding(0) var<uniform> bloomParams: BloomParams;

@fragment
fn PS_filter(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let in_color = textureSample(accLights, accLightsSampler, uv).rgb;
    
    // Calcular luminancia perceptual
    let lum = dot(in_color, vec3<f32>(0.2126, 0.7152, 0.0722));
    
    // Combinar luminancia con emisivos usando uniforms
    let emissive_contribution = g.emissive * bloomParams.emissive_factor;
    let total_brightness = lum + emissive_contribution;
    
    // Aplicar threshold usando uniforms
    let amount = smoothstep(bloomParams.threshold_min, bloomParams.threshold_max, total_brightness);
    
    return vec4<f32>(0.0);
    //return vec4<f32>(in_color.rgb * amount, 1.0);
}