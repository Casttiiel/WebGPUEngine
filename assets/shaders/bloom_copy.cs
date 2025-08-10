// Simple Copy Compute Shader
// Copies from source texture to destination texture

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

// Work group size optimized for GPU architecture
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = textureDimensions(dstTexture);
    let coords = vec2<i32>(global_id.xy);
    
    // Early exit if out of bounds
    if (coords.x >= i32(dstSize.x) || coords.y >= i32(dstSize.y)) {
        return;
    }
    
    // Calculate UV coordinates
    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);
    
    // Sample and copy
    let color = textureSampleLevel(srcTexture, srcSampler, uv, 0.0);
    
    // Store the result
    textureStore(dstTexture, coords, color);
}
