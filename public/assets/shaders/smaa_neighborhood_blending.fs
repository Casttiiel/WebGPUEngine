// SMAA Neighborhood Blending Fragment Shader
// Final blending pass that applies anti-aliasing based on calculated weights
// This is the third and final pass of the SMAA algorithm

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(2) @binding(0) var blendTex: texture_2d<f32>;
@group(2) @binding(1) var blendSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@fragment
fn main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texSize = textureDimensions(colorTex);
    let texelSize = 1.0 / vec2<f32>(texSize);
    
    // Sample blending weights
    let weights = textureSample(blendTex, blendSampler, in.uv);
    
    // If no blending needed, return original color
    if (dot(weights, vec4<f32>(1.0)) < 0.01) {
        return textureSample(colorTex, colorSampler, in.uv);
    }
    
    // Sample colors from neighbors based on weights
    var color = vec4<f32>(0.0);
    var totalWeight = 0.0;
    
    // Horizontal blending (left and right)
    if (weights.x > 0.0) {
        let leftColor = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(-texelSize.x, 0.0));
        color += leftColor * weights.x;
        totalWeight += weights.x;
    }
    if (weights.y > 0.0) {
        let rightColor = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(texelSize.x, 0.0));
        color += rightColor * weights.y;
        totalWeight += weights.y;
    }
    
    // Vertical blending (top and bottom)
    if (weights.z > 0.0) {
        let topColor = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(0.0, texelSize.y));
        color += topColor * weights.z;
        totalWeight += weights.z;
    }
    if (weights.w > 0.0) {
        let bottomColor = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(0.0, -texelSize.y));
        color += bottomColor * weights.w;
        totalWeight += weights.w;
    }
    
    // Add center color with remaining weight
    let centerColor = textureSample(colorTex, colorSampler, in.uv);
    let centerWeight = max(0.0, 1.0 - totalWeight);
    color += centerColor * centerWeight;
    totalWeight += centerWeight;
    
    // Normalize
    if (totalWeight > 0.0) {
        color /= totalWeight;
    } else {
        color = centerColor;
    }
    
    return color;
}
