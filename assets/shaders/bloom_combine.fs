#include "common/uniforms"

struct BloomUniforms {
    bloom_weights: vec4<f32>
}

@group(0) @binding(0) var<uniform> bloomParams: BloomUniforms;
@group(1) @binding(0) var bloomSampler: sampler;
@group(1) @binding(1) var bloom_0: texture_2d<f32>;
@group(1) @binding(2) var bloom_1: texture_2d<f32>;
@group(1) @binding(3) var bloom_2: texture_2d<f32>;
@group(1) @binding(4) var bloom_3: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let blurred_whites0 = textureSample(bloom_0, bloomSampler, uv).rgb;
    let blurred_whites1 = textureSample(bloom_1, bloomSampler, uv).rgb;
    let blurred_whites2 = textureSample(bloom_2, bloomSampler, uv).rgb;
    let blurred_whites3 = textureSample(bloom_3, bloomSampler, uv).rgb;
    
    let final_color = 
        blurred_whites0 * bloomParams.bloom_weights.x +
        blurred_whites1 * bloomParams.bloom_weights.y +
        blurred_whites2 * bloomParams.bloom_weights.z +
        blurred_whites3 * bloomParams.bloom_weights.w;

    return vec4<f32>(final_color, 1.0);
}
