// UI Additive Fragment Shader
// WebGPU Engine - UI System
// Renders UI effects with additive blending (for glows, particles, etc.)
// Color values add to the existing framebuffer

// UI-specific shader structs
// WebGPU Engine - UI System

/**
 * Vertex input for UI quads.
 * Uses vec3 position to match standard mesh format (Z is ignored).
 */
struct UIVertexInput {
    @location(0) position: vec3<f32>,  // 3D position (Z ignored for UI)
    @location(2) uv: vec2<f32>,        // Texture coordinates (location 2 = UV buffer)
}

/**
 * Vertex output / Fragment input for UI rendering.
 * Passes position and UV to fragment shader.
 */
struct UIVertexOutput {
    @builtin(position) position: vec4<f32>,  // Clip space position
    @location(0) uv: vec2<f32>,              // Interpolated UV
    @location(1) color: vec4<f32>,           // Vertex color (for tinting)
}


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
