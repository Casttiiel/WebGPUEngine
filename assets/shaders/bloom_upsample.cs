// Physically-Based Bloom Upsampling Compute Shader
// 3x3 tent filter with compute optimization

@group(0) @binding(0) var<uniform> upsampleParams: vec4<f32>; // filterRadius + padding
@group(0) @binding(1) var srcTexture: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;
@group(0) @binding(3) var dstTexture: texture_storage_2d<rgba16float, write>;

// Work group size optimized for GPU architecture
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = textureDimensions(dstTexture);
    let coords = vec2<i32>(global_id.xy);
    
    // Early exit if out of bounds
    if (coords.x >= i32(dstSize.x) || coords.y >= i32(dstSize.y)) {
        return;
    }
    
    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);
    
    // Fixed filter radius as per Learn OpenGL implementation
    // This should be a constant, not a variable parameter
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
    var result = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - x, uv.y + y), 0.0).rgb;      // top-left
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + x, uv.y + y), 0.0).rgb;         // top-right
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - x, uv.y - y), 0.0).rgb;         // bottom-left
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + x, uv.y - y), 0.0).rgb;         // bottom-right
    
    // Four edge samples (weight = 2)
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x,     uv.y + y), 0.0).rgb * 2.0;   // top
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - x, uv.y    ), 0.0).rgb * 2.0;   // left
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + x, uv.y    ), 0.0).rgb * 2.0;   // right
    result += textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x,     uv.y - y), 0.0).rgb * 2.0;   // bottom
    
    // Center sample (weight = 4)
    result += textureSampleLevel(srcTexture, srcSampler, uv, 0.0).rgb * 4.0;
    
    // Normalize: (1*4 + 2*4 + 4*1) = 16
    result *= 1.0 / 16.0;
    
    // Store the upsampled result directly (no additive blending for now)
    textureStore(dstTexture, coords, vec4<f32>(result, 1.0));
}
