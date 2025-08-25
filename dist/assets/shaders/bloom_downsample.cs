// Physically-Based Bloom Downsampling Compute Shader
// Based on Call of Duty: Advanced Warfare technique with compute optimization

@group(0) @binding(0) var<uniform> downsampleParams: vec4<f32>; // srcResolution.xy + padding
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
    
    // Calculate UV coordinates for the destination texture
    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);
    
    // Calculate texel size in source texture space
    let srcTexelSize = 1.0 / downsampleParams.xy;
    let x = srcTexelSize.x;
    let y = srcTexelSize.y;

    // Take 13 samples around current texel with bilinear filtering:
    // a - b - c
    // - j - k -
    // d - e - f
    // - l - m -
    // g - h - i
    // === ('e' is the current texel) ===
    
    let a = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - 2*x, uv.y + 2*y), 0.0).rgb;
    let b = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x,       uv.y + 2*y), 0.0).rgb;
    let c = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + 2*x, uv.y + 2*y), 0.0).rgb;

    let d = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - 2*x, uv.y), 0.0).rgb;
    let e = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x,       uv.y), 0.0).rgb;
    let f = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + 2*x, uv.y), 0.0).rgb;

    let g = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - 2*x, uv.y - 2*y), 0.0).rgb;
    let h = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x,       uv.y - 2*y), 0.0).rgb;
    let i = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + 2*x, uv.y - 2*y), 0.0).rgb;

    let j = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - x, uv.y + y), 0.0).rgb;
    let k = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + x, uv.y + y), 0.0).rgb;
    let l = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x - x, uv.y - y), 0.0).rgb;
    let m = textureSampleLevel(srcTexture, srcSampler, vec2<f32>(uv.x + x, uv.y - y), 0.0).rgb;

    // Apply weighted distribution:
    // 0.125*5 + 0.03125*4 + 0.0625*4 = 1
    var downsample = e * 0.125;
    downsample += (a + c + g + i) * 0.03125;
    downsample += (b + d + f + h) * 0.0625;
    downsample += (j + k + l + m) * 0.125;
    
    textureStore(dstTexture, coords, vec4<f32>(downsample, 1.0));
}
