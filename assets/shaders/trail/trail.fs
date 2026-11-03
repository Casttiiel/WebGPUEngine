@fragment
fn fs(
    @location(0) uv:    vec2<f32>,
    @location(1) color: vec4<f32>,
) -> @location(0) vec4<f32> {
    // Soft falloff along U axis (0=left edge, 1=right edge)
    let edge = 1.0 - abs(uv.x * 2.0 - 1.0);
    let alpha = color.a * edge * edge;
    return vec4<f32>(color.rgb, alpha);
}
