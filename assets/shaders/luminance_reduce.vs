struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Fullscreen triangle vertices
    let x = -1.0 + f32((vertexIndex & 1u) << 2u);
    let y = -1.0 + f32((vertexIndex & 2u) << 1u);
    
    var output: VertexOutput;
    output.uv = vec2<f32>((x + 1.0) * 0.5, (y + 1.0) * 0.5);
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    return output;
}
