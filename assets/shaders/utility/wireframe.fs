// Wireframe Fragment Shader
// Detecta bordes usando coordenadas baricéntricas

struct WireframeUniforms {
    color: vec4<f32>,
    lineWidth: f32,
    _padding: vec3<f32>,
};

@group(2) @binding(0) var<uniform> wireframe: WireframeUniforms;

@fragment
fn main() -> @location(0) vec4<f32> {
    return wireframe.color;
}
