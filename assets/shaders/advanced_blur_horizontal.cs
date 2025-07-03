struct AdvancedBlurUniforms {
    weights: vec4<f32>,        // [center, first, second, third]
    distanceFactors: vec4<f32>, // [first, second, third, fourth]
    globalDistance: f32,
    _padding1: f32,
    _padding2: f32,
    _padding3: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var textureSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: AdvancedBlurUniforms;

// Workgroup size for compute shader
const WORKGROUP_SIZE = 16u;

@compute @workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE, 1)
fn CS_advanced_blur(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let output_size = textureDimensions(outputTexture);
    
    // Early exit if out of bounds
    if (global_id.x >= output_size.x || global_id.y >= output_size.y) {
        return;
    }
    
    let output_coord = vec2<i32>(global_id.xy);
    let uv = (vec2<f32>(global_id.xy) + 0.5) / vec2<f32>(output_size);
    let texel_size = 1.0 / vec2<f32>(textureDimensions(inputTexture));
    
    // Extract weights and distance factors
    let w_center = uniforms.weights.x;
    let w_first = uniforms.weights.y;
    let w_second = uniforms.weights.z;
    let w_third = uniforms.weights.w;
    
    let d_first = uniforms.distanceFactors.x * uniforms.globalDistance;
    let d_second = uniforms.distanceFactors.y * uniforms.globalDistance;
    let d_third = uniforms.distanceFactors.z * uniforms.globalDistance;
    
    // Determine blur direction (horizontal or vertical based on pass)
    // For now, we'll do a 2D blur. In practice, you'd do separable passes.
    let blur_dir_x = texel_size.x;
    let blur_dir_y = texel_size.y;
    
    // 7-tap blur: center + 3 taps on each side
    // This is optimized for horizontal or vertical blur
    
    // For horizontal blur:
    let c0 = textureSampleLevel(inputTexture, textureSampler, uv, 0.0).rgb;
    let c_p1 = textureSampleLevel(inputTexture, textureSampler, uv - vec2<f32>(blur_dir_x * d_first, 0.0), 0.0).rgb;
    let c_n1 = textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(blur_dir_x * d_first, 0.0), 0.0).rgb;
    let c_p2 = textureSampleLevel(inputTexture, textureSampler, uv - vec2<f32>(blur_dir_x * d_second, 0.0), 0.0).rgb;
    let c_n2 = textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(blur_dir_x * d_second, 0.0), 0.0).rgb;
    let c_p3 = textureSampleLevel(inputTexture, textureSampler, uv - vec2<f32>(blur_dir_x * d_third, 0.0), 0.0).rgb;
    let c_n3 = textureSampleLevel(inputTexture, textureSampler, uv + vec2<f32>(blur_dir_x * d_third, 0.0), 0.0).rgb;
    
    // Weighted sum (similar to your PS function)
    let final_color = 
        c0 * w_center +
        (c_p1 + c_n1) * w_first +
        (c_p2 + c_n2) * w_second +
        (c_p3 + c_n3) * w_third;
    
    textureStore(outputTexture, output_coord, vec4<f32>(final_color, 1.0));
}
