// Bloom Additive Compute Shader
// Adds upsampled bloom result to existing accumulation texture

@group(0) @binding(0) var existingTexture: texture_2d<f32>;   // Current accumulated content
@group(0) @binding(1) var newTexture: texture_2d<f32>;       // New upsampled content to add
@group(0) @binding(2) var textureSampler: sampler;
@group(0) @binding(3) var resultTexture: texture_storage_2d<rgba16float, write>; // Output

// Work group size optimized for GPU architecture
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let resultSize = textureDimensions(resultTexture);
    let coords = vec2<i32>(global_id.xy);
    
    // Early exit if out of bounds
    if (coords.x >= i32(resultSize.x) || coords.y >= i32(resultSize.y)) {
        return;
    }
    
    // Calculate UV coordinates
    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(resultSize);
    
    // Sample both textures
    let existingColor = textureSampleLevel(existingTexture, textureSampler, uv, 0.0).rgb;
    let newColor = textureSampleLevel(newTexture, textureSampler, uv, 0.0).rgb;
    
    // Additive blend: D' = D + blur(E')
    let finalColor = existingColor + newColor;
    
    // Store the combined result
    textureStore(resultTexture, coords, vec4<f32>(finalColor, 1.0));
}
