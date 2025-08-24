#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var ssrTexture: texture_2d<f32>;
@group(0) @binding(1) var ssrSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let ssrColor = textureSample(ssrTexture, ssrSampler, uv);

    return vec4<f32>(ssrColor);
}
