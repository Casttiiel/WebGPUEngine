// UI Fragment Shader
// WebGPU Engine - UI System
// Renders UI quads with texture and color tint
// Uses alpha blending for transparency

#include "common/ui_structs"

@group(1) @binding(0) var uiTexture: texture_2d<f32>;
@group(1) @binding(1) var uiSampler: sampler;

@fragment
fn fs(input: UIVertexOutput) -> @location(0) vec4<f32> {
    // Sample texture and apply tint color
    let texColor = textureSample(uiTexture, uiSampler, input.uv);
    return texColor * input.color;
}
