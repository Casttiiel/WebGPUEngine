#include "common/uniforms"

// Gaussian blur uniforms matching your C++ implementation
struct GaussianBlurUniforms {
    blurStep: vec2<f32>,      // Texel step size (normalized)
    blurWeights: vec4<f32>,   // [center, first, second, third]
    blurDistances: vec4<f32>, // [first, second, third, unused]
    padding: vec4<f32>,       // Padding for alignment
}

// Vertex shader inputs/outputs
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) offset1: vec4<f32>,  // xy: +offset1, zw: -offset1
    @location(2) offset2: vec4<f32>,  // xy: +offset2, zw: -offset2
    @location(3) offset3: vec4<f32>,  // xy: +offset3, zw: -offset3
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> blurParams: GaussianBlurUniforms;

@vertex
fn vs(@location(0) position: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Convert to NDC space
    output.position = vec4<f32>(position * 2.0 - 1.0, 0.0, 1.0);
    output.uv = position;
    
    // Pre-calculate texture offsets in vertex shader (optimization from your C++ code)
    // This matches the VS function in blur.fx
    let step = blurParams.blurStep;
    let uv = position; // Use position directly as UV
    
    // Create temporary variables for all offsets
    let offset1Plus = uv + step * blurParams.blurDistances.x;
    let offset1Minus = uv - step * blurParams.blurDistances.x;
    let offset2Plus = uv + step * blurParams.blurDistances.y;
    let offset2Minus = uv - step * blurParams.blurDistances.y;
    let offset3Plus = uv + step * blurParams.blurDistances.z;
    let offset3Minus = uv - step * blurParams.blurDistances.z;
    
    // Assign the complete vectors at once (not component-wise)
    output.offset1 = vec4<f32>(offset1Plus.x, offset1Plus.y, offset1Minus.x, offset1Minus.y);
    output.offset2 = vec4<f32>(offset2Plus.x, offset2Plus.y, offset2Minus.x, offset2Minus.y);
    output.offset3 = vec4<f32>(offset3Plus.x, offset3Plus.y, offset3Minus.x, offset3Minus.y);
    
    return output;
}
