#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = object.modelMatrix * vec4<f32>(position, 1.0);
    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    let model3x3 = get3x3From4x4(object.modelMatrix);
    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    output.Uv = uv;
    return output;
}