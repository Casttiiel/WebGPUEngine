struct BloomUniforms {
    blurStrength: f32,
    blendIntensity: f32,
    _padding1: f32,
    _padding2: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var textureSampler: sampler;
@group(0) @binding(3) var higherResTexture: texture_2d<f32>; // Optional: for additive blending
@group(0) @binding(4) var<uniform> uniforms: BloomUniforms;

// Workgroup size for compute shader
const WORKGROUP_SIZE = 16u;

@compute @workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE, 1)
fn CS_upsample_blend(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let output_size = textureDimensions(outputTexture);
    
    // Early exit if out of bounds
    if (global_id.x >= output_size.x || global_id.y >= output_size.y) {
        return;
    }
    
    let output_coord = vec2<i32>(global_id.xy);
    let uv = (vec2<f32>(global_id.xy) + 0.5) / vec2<f32>(output_size);
    
    // Upsample with bilinear filtering
    let upsampled_color = textureSampleLevel(inputTexture, textureSampler, uv, 0.0).rgb;
    
    // Optionally blend with higher resolution texture (additive)
    let higher_res_color = textureSampleLevel(higherResTexture, textureSampler, uv, 0.0).rgb;
    
    // Additive blending with intensity control
    let blend_intensity = uniforms.blendIntensity;
    let final_color = higher_res_color + (upsampled_color * blend_intensity);
    
    textureStore(outputTexture, output_coord, vec4<f32>(final_color, 1.0));
}
