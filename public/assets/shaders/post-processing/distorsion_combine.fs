
@group(0) @binding(0) var distorsion: texture_2d<f32>;
@group(0) @binding(1) var distorsionSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(distorsion, distorsionSampler, uv);
    return vec4<f32>(color);
}