#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @location(4) joints:   vec4<u32>,
    @location(5) weights:  vec4<f32>,
) -> ShadowsVertexOutput {
    var skinMatrix = mat4x4<f32>(
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0)
    );
    skinMatrix += weights.x * jointMatrices[joints.x];
    skinMatrix += weights.y * jointMatrices[joints.y];
    skinMatrix += weights.z * jointMatrices[joints.z];
    skinMatrix += weights.w * jointMatrices[joints.w];

    let skinnedPos = skinMatrix * vec4<f32>(position, 1.0);
    let worldPos   = object.modelMatrix * skinnedPos;

    var output: ShadowsVertexOutput;
    output.worldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    return output;
}
