#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

// Joint palette — same layout as gbuffer_skinned.vs
@group(3) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @location(4) joints:   vec4<u32>,
    @location(5) weights:  vec4<f32>,
) -> VertexOutput {
    var out: VertexOutput;

    // Build skinning matrix from joint palette
    let skinMatrix =
        weights.x * jointMatrices[joints.x] +
        weights.y * jointMatrices[joints.y] +
        weights.z * jointMatrices[joints.z] +
        weights.w * jointMatrices[joints.w];

    // Skin position, then apply object model matrix to world space
    let skinnedPos = skinMatrix * vec4<f32>(position, 1.0);
    let worldPos   = object.modelMatrix * skinnedPos;

    out.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    out.WorldPos  = worldPos.xyz;
    out.Uv        = uv;

    // Unused fields required by VertexOutput
    out.N = vec3<f32>(0.0);
    out.T = vec4<f32>(0.0);

    return out;
}
