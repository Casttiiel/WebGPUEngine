#include "common/uniforms"

struct KawaseDownsampleUniforms {
    bloomSize: f32,
    padding: vec3<f32>, 
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(1) @binding(0) var<uniform> params: KawaseDownsampleUniforms;


@fragment
fn fs(
    @location(0) uv: vec2<f32>
) -> @location(0) vec4<f32> {
    let texSize = vec2<f32>(textureDimensions(inputTexture));
    let texelSize = 1.0 / texSize;
    let r = params.bloomSize;

    // 9 tap tent filter
    let a = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-r,-r)) * 1.0;
    let b = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(0,-r)) * 2.0;
    let c = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(r,-r)) * 1.0;
    let d = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-r,0)) * 2.0;
    let e = textureSample(inputTexture, inputSampler, uv) * 4.0;
    let f = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(r,0)) * 2.0;
    let g = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-r,r)) * 1.0;
    let h = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(0,r)) * 2.0;
    let i = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(r,r)) * 1.0;
    
    let finalColor = a + b + c + d + e + f + g + h + i;
    
    return finalColor / 16.0;
}
