#include "common/uniforms"

struct BloomUniforms {
    // x: bloom weight, y: lens dirt intensity, zw: unused
    bloom_weights: vec4<f32>
}

@group(0) @binding(0) var<uniform> bloomParams: BloomUniforms;
@group(1) @binding(0) var bloom_0: texture_2d<f32>;
@group(1) @binding(1) var bloomSampler: sampler;
@group(2) @binding(0) var lensDirt: texture_2d<f32>;
@group(2) @binding(1) var lensDirtSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let blurred_whites0 = textureSample(bloom_0, bloomSampler, uv).rgb;

    // Lens dirt: the dirt only shows where bloom lights it (UE-style modulation),
    // so dark frames stay clean and bright sources reveal smudges on the lens.
    let dirt = textureSample(lensDirt, lensDirtSampler, uv).rgb;
    let dirtFactor = vec3<f32>(1.0) + dirt * bloomParams.bloom_weights.y;

    let final_color =
        blurred_whites0 * bloomParams.bloom_weights.x * dirtFactor;

    return vec4<f32>(final_color, 1.0);
}
