// UI Fragment Shader
// WebGPU Engine - UI System
// Renders UI quads with texture and color tint
// Uses alpha blending for transparency

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
    // Sample texture and apply tint color
    let texColor = textureSample(uiTexture, uiSampler, input.uv);
    return texColor * input.color;
}
