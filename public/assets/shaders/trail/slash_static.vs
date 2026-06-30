#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object:  ObjectUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv:         vec2<f32>,
    @location(1) color:      vec4<f32>,
};

@vertex
fn vs(in: VertexInput) -> VertexOutput {
    let worldPos = object.modelMatrix * vec4<f32>(in.position, 1.0);
    var out: VertexOutput;
    out.clip  = camera.projectionMatrix * camera.viewMatrix * worldPos;
    out.uv    = in.uv;
    // Use tangent.rgb as tint so color can be driven from mesh tangent data;
    // w component carries alpha. Default cube tangents are (1,0,0,1) → warm orange-ish.
    // Override by setting vertex colors or rely on the FS three-tone gradient.
    out.color = vec4<f32>(0.4, 0.75, 1.0, 1.0); // blue-white tint for preview
    return out;
}
