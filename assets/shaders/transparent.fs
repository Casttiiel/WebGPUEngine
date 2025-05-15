@group(2) @binding(0) var textureSampler: texture_2d<f32>;
@group(2) @binding(1) var samplerState: sampler;


@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let textureColor = textureSample(textureSampler, samplerState, input.Uv);
    
    return vec4<f32>(textureColor.xyz, 0.5);
}