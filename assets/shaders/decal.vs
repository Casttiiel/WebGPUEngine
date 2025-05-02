struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}
@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(2) uv: vec2<f32>,
) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(position, 1.0);
    output.uv = uv;
    return output;
}