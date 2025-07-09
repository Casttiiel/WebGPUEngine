#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var originalTexture: texture_2d<f32>;
@group(1) @binding(1) var originalSampler: sampler;
@group(2) @binding(0) var bloomTexture: texture_2d<f32>;
@group(2) @binding(1) var bloomSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let original = textureSample(originalTexture, originalSampler, uv).rgb;
    let bloom = textureSample(bloomTexture, bloomSampler, uv).rgb;
    
    // Simple additive blend of original and bloom
    let final_color = original + bloom;
    
    return vec4<f32>(final_color, 1.0);
}
