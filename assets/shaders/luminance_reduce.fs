struct Uniforms {
    texelSize: vec2<f32>,  // 1.0 / texture dimensions
    pad: vec2<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var defaultSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample 4 neighboring texels for reduction
    var coords: array<vec2<f32>, 4>;
    coords[0] = input.uv + vec2<f32>(-0.5, -0.5) * uniforms.texelSize;
    coords[1] = input.uv + vec2<f32>( 0.5, -0.5) * uniforms.texelSize;
    coords[2] = input.uv + vec2<f32>(-0.5,  0.5) * uniforms.texelSize;
    coords[3] = input.uv + vec2<f32>( 0.5,  0.5) * uniforms.texelSize;
    
    var lumSum: f32 = 0.0;
    for(var i: i32 = 0; i < 4; i = i + 1) {
        lumSum = lumSum + textureSample(inputTexture, defaultSampler, coords[i]).r;
    }
    
    // Average of the 4 samples
    return vec4<f32>(lumSum * 0.25, 0.0, 0.0, 1.0);
}
