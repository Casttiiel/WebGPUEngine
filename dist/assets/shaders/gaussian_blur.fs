#include "common/uniforms"

struct GaussianBlurUniforms {
    blur_w: vec4<f32>, 
    blur_d: vec3<f32>, 
    global_distance: f32,
    direction: vec2<f32>,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(1) @binding(0) var<uniform> blurParams: GaussianBlurUniforms;


@fragment
fn fs(
    @location(0) uv: vec2<f32>,
    @location(1) offset1: vec4<f32>,
    @location(2) offset2: vec4<f32>,
    @location(3) offset3: vec4<f32>
) -> @location(0) vec4<f32> {
    // 7-tap Gaussian blur exactly like your C++ PS function
    // Sample all 7 points using pre-calculated offsets
    let cp3 = textureSample(inputTexture, inputSampler, offset3.zw);
    let cp2 = textureSample(inputTexture, inputSampler, offset2.zw);
    let cp1 = textureSample(inputTexture, inputSampler, offset1.zw);
    let c0  = textureSample(inputTexture, inputSampler, uv);
    let cn1 = textureSample(inputTexture, inputSampler, offset1.xy);
    let cn2 = textureSample(inputTexture, inputSampler, offset2.xy);
    let cn3 = textureSample(inputTexture, inputSampler, offset3.xy);
    
    // Weighted sum using normalized weights
    let finalColor = 
        (c0)        * blurParams.blur_w.x +
        (cp1 + cn1) * blurParams.blur_w.y +
        (cp2 + cn2) * blurParams.blur_w.z +
        (cp3 + cn3) * blurParams.blur_w.w;
    
    return finalColor;
}
