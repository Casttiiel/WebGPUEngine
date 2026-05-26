#include "common/uniforms"

struct RCParams {
    cascadeIndex:  f32,
    cascadeCount:  f32,
    baseRange:     f32,
    intervalStart: f32,
    intervalEnd:   f32,
    raysPerProbe:  f32,
    maxSteps:      f32,
    giIntensity:   f32,  // temporalBlend slot reused as intensity here
    cascadeRes:    vec2<f32>,
    screenSize:    vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// GI contribution computed by rc_apply.cs (irradiance × albedo × diffuse_factor)
@group(1) @binding(0) var giResult:   texture_2d<f32>;
@group(1) @binding(1) var samplerGI:  sampler;

// RCParams — only giIntensity (slot 7) is read here
@group(2) @binding(0) var<uniform> rc: RCParams;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let gi = textureSampleLevel(giResult, samplerGI, uv, 0.0);
    return vec4<f32>(gi.rgb * rc.giIntensity, 0.0);
}
