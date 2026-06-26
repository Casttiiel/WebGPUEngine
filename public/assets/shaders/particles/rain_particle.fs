// Texture bindings declared to satisfy the MaterialTextures bind group slot,
// but rain streaks are drawn procedurally — no texture sample needed.
@group(1) @binding(0) var txAlbedo:  texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;

@fragment
fn fs(
    @location(0) uv:            vec2<f32>,
    @location(1) particleColor: vec4<f32>,
) -> @location(0) vec4<f32> {
    // Fade at the tips of the streak (uv.y along velocity direction)
    let tipFade  = smoothstep(0.0, 0.15, uv.y) * smoothstep(1.0, 0.85, uv.y);
    // Soft edges along the width
    let sideFade = 1.0 - abs(uv.x * 2.0 - 1.0);
    let alpha    = tipFade * sideFade * particleColor.a;
    return vec4<f32>(particleColor.rgb, alpha);
}
