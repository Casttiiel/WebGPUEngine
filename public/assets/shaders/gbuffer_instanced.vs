#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
    // Read model matrix from storage buffer using instance index
    let modelMatrix = instanceMatrices[instanceIdx];
    
    var output: VertexOutput;
    let worldPos = modelMatrix * vec4<f32>(position, 1.0);
    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    // Transform normal and tangent to world space
    let model3x3 = get3x3From4x4(modelMatrix);
    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    output.Uv = uv;
    
    return output;
}
