// UI Vertex Shader
// WebGPU Engine - UI System
// Transforms 2D UI quads using world transformation matrix

#include "common/ui_structs"
#include "common/ui_uniforms"

@group(0) @binding(0) var<uniform> ui: UIUniforms;

@vertex
fn vs(input: UIVertexInput) -> UIVertexOutput {
    var output: UIVertexOutput;
    
    // Transform vertex position using UI world matrix
    // Input position is in local space (-0.5 to 0.5 for unit quad)
    // Output position is in clip space (-1 to 1)
    output.position = ui.transform * vec4<f32>(input.position, 0.0, 1.0);
    
    // Remap UVs based on minUV and maxUV (for texture atlasing and animation)
    // mix() does: minUV + input.uv * (maxUV - minUV)
    output.uv = mix(ui.minUV, ui.maxUV, input.uv);
    
    // Pass tint color to fragment shader
    output.color = ui.tint;
    
    return output;
}
