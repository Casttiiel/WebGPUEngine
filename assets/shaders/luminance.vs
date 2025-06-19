struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) position: vec4<f32>,
      @location(1) uv: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position = position;
    output.uv = uv;
    return output;
}
