@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Use a color con alfa para que sea visible pero semitransparente
    return vec4<f32>(1.0, 0.0, 0.0, 0.5); // Rojo semitransparente
}