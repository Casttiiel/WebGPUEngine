// Bloom Combine Compute Shader
// Combines original texture with bloom result according to Learn OpenGL technique

@group(0) @binding(0) var originalTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var textureSampler: sampler;
@group(0) @binding(3) var resultTexture: texture_storage_2d<rgba16float, write>;

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
    
    // Sample original and bloom textures
    let originalColor = textureSampleLevel(originalTexture, textureSampler, uv, 0.0).rgb;
    let bloomColor = textureSampleLevel(bloomTexture, textureSampler, uv, 0.0).rgb;
    
    // Combine original + bloom using mix
    // Using hardcoded bloom strength of 0.04 as recommended by Jorge Jimenez
    // Good values can go from 0.03 and 0.15
    let finalColor = mix(originalColor, bloomColor, 0.05);
    
    // Store the combined result
    textureStore(resultTexture, coords, vec4<f32>(finalColor, 1.0));
}
