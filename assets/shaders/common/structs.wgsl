struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) selfIllum: vec4<f32>,
    @location(3) depth: f32,
}
