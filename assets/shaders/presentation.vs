struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@location(0) position: vec3<f32>,) -> Output {
  var output: Output;
  output.position = vec4<f32>(position.xy, 1.0, 1.0);
  output.uv = position.xy * 0.5 + 0.5; // Convertir de [-1, 1] a [0, 1]

  return output;
}