// UI Vertex Shader
// WebGPU Engine - UI System
// Transforms 2D UI quads using world transformation matrix

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


@group(0) @binding(0) var<uniform> ui: UIUniforms;

@vertex
fn vs(input: UIVertexInput) -> UIVertexOutput {
    var output: UIVertexOutput;
    
    // Transform vertex position using UI world matrix
    // Input position is vec3 but we only use XY (Z is ignored for UI)
    // Output position is in clip space (-1 to 1)
    output.position = ui.transform * vec4<f32>(input.position.xy, 0.0, 1.0);
    
    // Remap UVs based on minUV and maxUV (for texture atlasing and animation)
    // mix() does: minUV + input.uv * (maxUV - minUV)
    // Flip V coordinate (Y) to match WebGPU texture convention
    let flippedUV = vec2<f32>(input.uv.x, 1.0 - input.uv.y);
    output.uv = mix(ui.minUV, ui.maxUV, flippedUV);
    
    // Pass tint color to fragment shader
    output.color = ui.tint;
    
    return output;
}
