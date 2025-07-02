#include "common/uniforms"

struct BloomParams {
  intensity: f32,
  threshold: f32,
  knee: f32,
  radius: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var originalTexture: texture_2d<f32>;
@group(1) @binding(1) var originalSampler: sampler;
@group(2) @binding(0) var bloomTexture: texture_2d<f32>;
@group(2) @binding(1) var bloomSampler: sampler;
@group(3) @binding(0) var<uniform> bloomParams: BloomParams;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let original = textureSample(originalTexture, originalSampler, uv).rgb;
    let bloom = textureSample(bloomTexture, bloomSampler, uv).rgb;
    
    // Combine original and bloom with intensity control
    let final_color = original + (bloom * bloomParams.intensity);
    
    return vec4<f32>(final_color, 1.0);
}
