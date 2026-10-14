#include "common/uniforms"
#include "common/structs"

// Instanced variant of shadows_mask.vs.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;

struct ShadowsMaskVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @builtin(instance_index) instanceIdx: u32
) -> ShadowsMaskVertexOutput {
    var output: ShadowsMaskVertexOutput;
    let worldPos = instanceMatrices[instanceIdx] * vec4<f32>(position, 1.0);
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    output.uv = uv;
    return output;
}
