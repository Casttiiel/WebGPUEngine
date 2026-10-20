@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>,
#ifdef LIT
    @location(2) fog: vec4<f32>,
#endif
) -> @location(0) vec4<f32> {
    // Muestrear la textura albedo
    let texColor = textureSample(txAlbedo, txSampler, uv);

    // Multiplicar textura por el color interpolado (startColor → endColor según edad)
    var color = texColor * particleColor;
#ifdef LIT
    // La niebla entre la cámara y la partícula (se dibuja después de la composición de niebla).
    color = vec4<f32>(color.rgb * fog.a + fog.rgb, color.a);
#endif
    return color;
}
