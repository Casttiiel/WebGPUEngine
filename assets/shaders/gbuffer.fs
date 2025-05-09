@group(2) @binding(0) var textureSampler: texture_2d<f32>;
@group(2) @binding(1) var samplerState: sampler;

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) selfIllum: vec4<f32>,
    @location(3) depth: f32,
}

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let textureColor = textureSample(textureSampler, samplerState, input.Uv);
    
    var output: FragmentOutput;
    output.albedo = textureColor;
    output.normal = vec4<f32>(normalize(input.N), 1.0);
    output.selfIllum = vec4<f32>(0.0);
    output.depth = 1.0;
    
    return output;
}