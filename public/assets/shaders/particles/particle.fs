@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>,
) -> @location(0) vec4<f32> {
    // Muestrear la textura albedo
    let texColor = textureSample(txAlbedo, txSampler, uv);

    // Multiplicar textura por el color interpolado (startColor → endColor según edad)
    return texColor * particleColor;
}