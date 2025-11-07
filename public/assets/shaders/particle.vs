#include "common/uniforms"

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) instancePosition: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(vertex: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Apply instance offset to vertex position
    var localPos = vertex.position + vertex.instancePosition;
    
    // Transform to world space
    var worldPos = object.modelMatrix * vec4<f32>(localPos, 1.0);
    
    // Transform to clip space
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    output.uv = vertex.uv;
    
    return output;
}