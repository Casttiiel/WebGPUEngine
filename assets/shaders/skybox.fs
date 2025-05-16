@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let textureColor = textureSample(textureSampler, samplerState, uv);
    
    return vec4<f32>(textureColor.xyz, 0.5);
}