#include "common/uniforms"

struct VertexInput {
    @location(0) position: vec3<f32>, // world-space position (baked by CPU)
    @location(1) normal:   vec3<f32>, // unused
    @location(2) uv:       vec2<f32>, // (0|1 = left|right edge, t = position along trail)
    @location(3) color:    vec4<f32>, // rgba color packed in tangent slot
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv:         vec2<f32>,
    @location(1) color:      vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
// @group(1) = MaterialTextures (bound by render manager, not sampled)
@group(2) @binding(0) var<uniform> object: ObjectUniforms; // declared for layout compat; ignored

@vertex
fn vs(in: VertexInput) -> VertexOutput {
    // Trail vertices are pre-computed in world space — skip model matrix transform
    let clip = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(in.position, 1.0);
    var out: VertexOutput;
    out.clip  = clip;
    out.uv    = in.uv;
    out.color = in.color;
    return out;
}
