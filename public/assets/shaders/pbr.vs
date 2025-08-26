#include "common/uniforms"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,                                             
    @location(3) tangent: vec4<f32>
) -> @builtin(position) vec4<f32> {
    let worldPos = object.modelMatrix * vec4<f32>(position, 1.0);

    return camera.projectionMatrix * camera.viewMatrix * worldPos;
}