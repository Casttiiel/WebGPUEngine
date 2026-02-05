// UI Additive Fragment Shader
// WebGPU Engine - UI System
// Renders UI effects with additive blending (for glows, particles, etc.)
// Color values add to the existing framebuffer

#include "common/ui_structs"

@group(1) @binding(0) var uiTexture: texture_2d<f32>;
@group(1) @binding(1) var uiSampler: sampler;

@fragment
fn fs(input: UIVertexOutput) -> @location(0) vec4<f32> {
    // Sample texture at interpolated UV coordinates
    var textureColor = textureSample(uiTexture, uiSampler, input.uv);
    
    // Apply tint color (multiplicative)
    var finalColor = textureColor * input.color;
    
    // For additive blending, the alpha channel controls the blend intensity
    // The pipeline will be configured with:
    // - srcFactor: 'src-alpha'
    // - dstFactor: 'one'
    // - operation: 'add'
    // This creates: finalColor.rgb * finalColor.a + destinationColor.rgb
    
    // Ensure color values are in HDR range if needed
    // For bright glows, tint.rgb can have values > 1.0
    return finalColor;
}
