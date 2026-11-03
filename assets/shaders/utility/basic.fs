@group(2) @binding(0) var textureSampler: texture_2d<f32>;
@group(2) @binding(1) var samplerState: sampler;

@fragment
fn fs(
    @location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>
) -> @location(0) vec4<f32> {
    // Muestrear la textura usando las coordenadas UV
    let textureColor = textureSample(textureSampler, samplerState, Uv);
    return textureColor;
}

