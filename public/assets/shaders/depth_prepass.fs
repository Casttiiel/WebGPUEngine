#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var txAlbedoSampler: sampler;

@fragment
fn fs(input: VertexOutput) {
    // Alpha testing for masked materials (foliage, fences, etc.)
    // Sample albedo texture to get alpha channel
    let albedo = textureSample(txAlbedo, txAlbedoSampler, input.Uv);
    
    // Discard fragments with low alpha (matches behavior of main rendering pass)
    // This prevents depth prepass from writing depth for pixels that will be discarded later
    if (albedo.a < 0.5) {
        discard;
    }
    
    // No color output needed - depth buffer is filled automatically by GPU
}
