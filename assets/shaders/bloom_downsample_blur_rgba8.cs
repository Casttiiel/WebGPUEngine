struct BloomUniforms {
    blurStrength: f32,
    _padding1: f32,
    _padding2: f32,
    _padding3: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var textureSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: BloomUniforms;

// Workgroup size for compute shader
const WORKGROUP_SIZE = 16u;

@compute @workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE, 1)
fn CS_downsample_blur(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let output_size = textureDimensions(outputTexture);
    let input_size = textureDimensions(inputTexture);
    
    // Early exit if out of bounds
    if (global_id.x >= output_size.x || global_id.y >= output_size.y) {
        return;
    }
    
    let output_coord = vec2<i32>(global_id.xy);
    let uv = (vec2<f32>(global_id.xy) + 0.5) / vec2<f32>(output_size);
    
    // Sample multiple points for better downsampling quality
    let texel_size = 1.0 / vec2<f32>(input_size);
    
    // 3x3 tent filter for high-quality downsampling
    var color = vec3<f32>(0.0);
    var total_weight = 0.0;
    
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texel_size;
            let sample_uv = uv + offset;
            
            // Weight based on distance from center (tent filter)
            let weight = (2.0 - abs(f32(x))) * (2.0 - abs(f32(y))) / 4.0;
            
            let sample_color = textureSampleLevel(inputTexture, textureSampler, sample_uv, 0.0).rgb;
            color += sample_color * weight;
            total_weight += weight;
        }
    }
    
    color /= total_weight;
    
    // Additional blur pass (separable gaussian approximation)
    let blur_strength = uniforms.blurStrength;
    var blurred_color = color * 0.25;
    
    // Horizontal blur samples
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(-texel_size.x * blur_strength, 0.0), 0.0).rgb * 0.125;
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(texel_size.x * blur_strength, 0.0), 0.0).rgb * 0.125;
    
    // Vertical blur samples
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(0.0, -texel_size.y * blur_strength), 0.0).rgb * 0.125;
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(0.0, texel_size.y * blur_strength), 0.0).rgb * 0.125;
    
    // Diagonal samples
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(-texel_size.x * blur_strength, -texel_size.y * blur_strength), 0.0).rgb * 0.0625;
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(texel_size.x * blur_strength, -texel_size.y * blur_strength), 0.0).rgb * 0.0625;
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(-texel_size.x * blur_strength, texel_size.y * blur_strength), 0.0).rgb * 0.0625;
    blurred_color += textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(texel_size.x * blur_strength, texel_size.y * blur_strength), 0.0).rgb * 0.0625;
    
    // Clamp to [0,1] range for RGBA8 format
    blurred_color = clamp(blurred_color, vec3<f32>(0.0), vec3<f32>(1.0));
    
    textureStore(outputTexture, output_coord, vec4<f32>(blurred_color, 1.0));
}
