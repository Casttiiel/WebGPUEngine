#include "common/uniforms"

// Gaussian blur uniforms matching your C++ implementation
struct GaussianBlurUniforms {
    blurStep: vec2<f32>,      // Texel step size (normalized)
    blurWeights: vec4<f32>,   // [center, first, second, third]
    blurDistances: vec4<f32>, // [first, second, third, unused]
    padding: vec4<f32>,       // Padding for alignment
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> blurParams: GaussianBlurUniforms;
@group(2) @binding(0) var inputTexture: texture_2d<f32>;
@group(2) @binding(1) var inputSampler: sampler;

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
        (c0)        * blurParams.blurWeights.x +
        (cp1 + cn1) * blurParams.blurWeights.y +
        (cp2 + cn2) * blurParams.blurWeights.z +
        (cp3 + cn3) * blurParams.blurWeights.w;
    
    return finalColor;
}
