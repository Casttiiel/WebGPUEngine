#include "common/uniforms"

struct VsIn {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) worldPos:   vec3<f32>,
    // Camera position baked into object space so the FS can skip ObjectUniforms
    // (ObjectUniforms layout is vertex-only; FS access would fail pipeline creation).
    @location(1) roOS:       vec3<f32>,  // camera world pos → object space
    @location(2) col0:       vec3<f32>,  // modelMatrix column 0 (X axis * scaleX)
    @location(3) col1:       vec3<f32>,  // modelMatrix column 1
    @location(4) col2:       vec3<f32>,  // modelMatrix column 2
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

fn worldToObjectSpace(pWS: vec3<f32>, m: mat4x4<f32>) -> vec3<f32> {
    let sx2 = dot(m[0].xyz, m[0].xyz);
    let sy2 = dot(m[1].xyz, m[1].xyz);
    let sz2 = dot(m[2].xyz, m[2].xyz);
    let d   = pWS - m[3].xyz;
    return vec3<f32>(
        dot(d, m[0].xyz) / sx2,
        dot(d, m[1].xyz) / sy2,
        dot(d, m[2].xyz) / sz2,
    );
}

@vertex
fn vs(in: VsIn) -> VsOut {
    let m        = object.modelMatrix;
    let worldPos = (m * vec4<f32>(in.position, 1.0)).xyz;
    var out: VsOut;
    out.worldPos = worldPos;
    out.clip     = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    out.roOS     = worldToObjectSpace(camera.cameraPosition.xyz, m);
    out.col0     = m[0].xyz;
    out.col1     = m[1].xyz;
    out.col2     = m[2].xyz;
    return out;
}
