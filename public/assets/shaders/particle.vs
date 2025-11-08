#include "common/uniforms"

// Estructura de la partícula (alineada para storage buffer)
struct Particle {
    position: vec3<f32>,
    padding: f32, // Alineamiento requerido para vec3 en storage buffer
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;

// Vertex attributes del quad mesh
struct VertexInput {
    @location(0) position: vec3<f32>, // posición del vértice del quad
    @location(1) normal: vec3<f32>,   // normal del quad (no se usa pero está en el mesh)
    @location(2) uv: vec2<f32>,       // UV del quad
    @location(3) tangent: vec4<f32>,  // tangent del quad (no se usa pero está en el mesh)
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    // Obtener la partícula actual usando el instance index
    let particle = particles[input.instanceIndex];
    
    var output: VertexOutput;

    let worldPos = object.modelMatrix * vec4<f32>(input.position, 1.0);
    output.position = camera.projectionMatrix * camera.viewMatrix * (worldPos + vec4<f32>(particle.position, 1.0));
    output.uv = input.uv;
    
    return output;
}