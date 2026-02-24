#include "common/uniforms"

struct BloomUniforms {
    bloom_weights: vec4<f32>
}

@group(0) @binding(0) var<uniform> bloomParams: BloomUniforms;
@group(1) @binding(0) var bloom_0: texture_2d<f32>;
@group(1) @binding(1) var bloomSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let blurred_whites0 = textureSample(bloom_0, bloomSampler, uv).rgb;
    
    let final_color = 
        blurred_whites0 * bloomParams.bloom_weights.x;

    return vec4<f32>(final_color, 1.0);
}