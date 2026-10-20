#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "gbuffer/pom_common"

// Vertex stage of the POM G-buffer techniques.
//   INSTANCED  model matrix from the instance storage buffer (gbuffer_pom_instanced.tech)
// The box frame (centre, axes, half extents of the unit cube scaled by the model matrix)
// is always passed: the BOX / SILHOUETTE fragment paths project and clip with it.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
#ifdef INSTANCED
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;
#else
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
#endif

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @builtin(instance_index) instanceIdx: u32,
) -> POMVertexOutput {
#ifdef INSTANCED
    let model = instanceMatrices[instanceIdx];
#else
    let model = object.modelMatrix;
#endif
    var output: POMVertexOutput;

    let worldPos4 = model * vec4<f32>(position, 1.0);
    let model3x3  = get3x3From4x4(model);

    output.N        = normalize(model3x3 * normal);
    output.T        = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    output.WorldPos = worldPos4.xyz;
    output.Uv       = uv;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos4;

    let ax = model[0].xyz;
    let ay = model[1].xyz;
    let az = model[2].xyz;
    output.BoxCenter = model[3].xyz;
    output.BoxAxisX  = normalize(ax);
    output.BoxAxisY  = normalize(ay);
    output.BoxAxisZ  = normalize(az);
    output.BoxHalf   = 0.5 * vec3<f32>(length(ax), length(ay), length(az));

    return output;
}
