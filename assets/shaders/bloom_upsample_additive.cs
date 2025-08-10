// Bloom Upsample with Additive Blending Compute Shader
// Combines 3x3 tent filter upsampling with additive blending in one pass

@group(0) @binding(0) var existingTexture: texture_2d<f32>;   // Current accumulated content
@group(0) @binding(1) var srcTexture: texture_2d<f32>;       // Source mip to upsample
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
    
    // Sample existing accumulated content
    let existingColor = textureSampleLevel(existingTexture, textureSampler, uv, 0.0).rgb;
    
    // Perform 3x3 tent filter upsampling on source texture
    let srcSize = textureDimensions(srcTexture);
    let srcTexelSize = 1.0 / vec2<f32>(srcSize);
    
    // Use fixed 1-pixel offset in source texture space
    let x = srcTexelSize.x;
    let y = srcTexelSize.y;

    // 3x3 tent filter
    // Take 9 samples around current texel:
    // 1 - 2 - 1
    // 2 - 4 - 2
    // 1 - 2 - 1
    
    // Four corner samples (weight = 1)
    var upsampledColor = textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x - x, uv.y + y), 0.0).rgb;      // top-left
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x + x, uv.y + y), 0.0).rgb;         // top-right
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x - x, uv.y - y), 0.0).rgb;         // bottom-left
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x + x, uv.y - y), 0.0).rgb;         // bottom-right
    
    // Four edge samples (weight = 2)
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x,     uv.y + y), 0.0).rgb * 2.0;   // top
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x - x, uv.y    ), 0.0).rgb * 2.0;   // left
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x + x, uv.y    ), 0.0).rgb * 2.0;   // right
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, vec2<f32>(uv.x,     uv.y - y), 0.0).rgb * 2.0;   // bottom
    
    // Center sample (weight = 4)
    upsampledColor += textureSampleLevel(srcTexture, textureSampler, uv, 0.0).rgb * 4.0;
    
    // Normalize: (1*4 + 2*4 + 4*1) = 16
    upsampledColor *= 1.0 / 16.0;
    
    // Additive blending: D' = D + blur(E')
    let finalColor = existingColor + upsampledColor;
    
    // Store the combined result
    textureStore(resultTexture, coords, vec4<f32>(finalColor, 1.0));
}
