// UI-specific shader uniforms
// WebGPU Engine - UI System

/**
 * UI Transform and appearance uniforms.
 * Contains all data needed to transform and render a UI widget.
 * 
 * Bind Group Layout: @group(0) @binding(0)
 */
struct UIUniforms {
    transform: mat4x4<f32>,     // World transformation matrix (includes position, rotation, scale)
    tint: vec4<f32>,            // Color tint (RGBA), allows color modulation
    minUV: vec2<f32>,           // Minimum UV coordinates (for UV remapping/animation)
    maxUV: vec2<f32>,           // Maximum UV coordinates (for UV remapping/animation)
}
