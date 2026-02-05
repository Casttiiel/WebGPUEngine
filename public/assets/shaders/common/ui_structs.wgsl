// UI-specific shader structs
// WebGPU Engine - UI System

/**
 * Vertex input for UI quads.
 * Simple 2D position + UV coordinates.
 */
struct UIVertexInput {
    @location(0) position: vec2<f32>,  // 2D position in UI space
    @location(1) uv: vec2<f32>,        // Texture coordinates
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
