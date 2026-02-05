// UI Fragment Shader
// WebGPU Engine - UI System
// Renders UI quads with texture and color tint
// Uses alpha blending for transparency

#include "common/ui_structs"

@group(1) @binding(0) var uiTexture: texture_2d<f32>;
@group(1) @binding(1) var uiSampler: sampler;

@fragment
fn fs(input: UIVertexOutput) -> @location(0) vec4<f32> {
    // Sample texture at interpolated UV coordinates
    var textureColor = textureSample(uiTexture, uiSampler, input.uv);
    
    // Apply tint color (multiplicative)
    // This allows color modulation and alpha control
    var finalColor = textureColor * input.color;
    
    // Return final color with alpha
    // Alpha blending will be handled by the pipeline state
    return finalColor;
}
