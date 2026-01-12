
// Wireframe Vertex Shader
// Usa coordenadas baricéntricas para detectar bordes en el fragment shader

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    screenSize: vec2<f32>,
    cameraFront: vec3<f32>,
    cameraZFar: f32,
    invProjection: mat4x4<f32>,
};

struct ObjectUniforms {
    model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) barycentric: vec3<f32>,  // Coordenadas baricéntricas
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) barycentric: vec3<f32>,
};

@vertex
fn main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // Transform position to clip space usando matrices de cámara
    let worldPos = object.model * vec4<f32>(in.position, 1.0);
    out.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    // Pass barycentric coordinates to fragment shader
    out.barycentric = in.barycentric;
    
    return out;
}
