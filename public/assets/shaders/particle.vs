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
    
    // Get the camera right and up vectors from the view matrix
    let cameraRight = vec3<f32>(camera.viewMatrix[0].x, camera.viewMatrix[1].x, camera.viewMatrix[2].x);
    let cameraUp = vec3<f32>(camera.viewMatrix[0].y, camera.viewMatrix[1].y, camera.viewMatrix[2].y);
    
    // Scale the billboard vectors by the original vertex position (which defines quad corners)
    let rightOffset = cameraRight * vertex.position.x;
    let upOffset = cameraUp * vertex.position.y;
    
    // Calculate world position = instancePosition + billboarded quad offset
    let worldPos = vec4<f32>(
        vertex.instancePosition + rightOffset + upOffset,
        1.0
    );
    
    // Transform to clip space
    output.position = camera.projectionMatrix * camera.viewMatrix * object.modelMatrix * worldPos;
    output.uv = vertex.uv;
    
    return output;
}