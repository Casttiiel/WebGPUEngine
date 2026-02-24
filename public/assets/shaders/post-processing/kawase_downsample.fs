#include "common/uniforms"

struct KawaseDownsampleUniforms {
    texelX: f32,
    texelY: f32,
    padding: vec2<f32>, 
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

    // Jorge Jimenez/COD, 13 samples pattern with weights
    let a = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-2,-2));
    let b = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(0,-2));
    let c = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(2,-2));
    let d = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-1,-1));
    let e = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(1,-1));
    let f = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-2,0));
    let g = textureSample(inputTexture, inputSampler, uv);
    let h = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(2,0));
    let i = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-1,1));
    let j = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(1,1));
    let k = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(-2,2));
    let l = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(0,2));
    let m = textureSample(inputTexture, inputSampler, uv + texelSize * vec2<f32>(2,2));
    
    // Weighted sum using normalized weights
    let finalColor = 
        (g)        * 0.125 +
        (a + c + k + m) * 0.03125 +
        (b + f + h + l) * 0.0625 +
        (d + e + i + j) * 0.125;
    
    return finalColor;
}
