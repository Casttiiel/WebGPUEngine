#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> DecalVertexOutput {
    var output: DecalVertexOutput;

    let worldPos = object.modelMatrix * vec4<f32>(position, 1.0);
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;

    let center  = vec3<f32>(object.modelMatrix[3].x, object.modelMatrix[3].y, object.modelMatrix[3].z);
    let decal_x = vec3<f32>(object.modelMatrix[0].x, object.modelMatrix[0].y, object.modelMatrix[0].z);
    let decal_z = vec3<f32>(object.modelMatrix[2].x, object.modelMatrix[2].y, object.modelMatrix[2].z);
    let decal_y = vec3<f32>(object.modelMatrix[1].x, object.modelMatrix[1].y, object.modelMatrix[1].z);

    // All three axes are now measured from the minimum corner of the cube,
    // so amount_of_x/y/z all fall in [0, 1] inside the volume — consistent.
    output.decal_top_left = center - decal_x * 0.5 - decal_z * 0.5 - decal_y * 0.5;
    output.decal_axis_x = decal_x;
    output.decal_axis_z = decal_z;
    output.decal_axis_y = decal_y;

    return output;
}
