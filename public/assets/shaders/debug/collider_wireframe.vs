#include "common/uniforms"

struct VertexInput {
    @location(0) position : vec3<f32>,
    @location(1) color    : vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clipPos : vec4<f32>,
    @location(0)       color   : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : CameraUniforms;

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(input.position, 1.0);
    out.color   = input.color;
    return out;
}
