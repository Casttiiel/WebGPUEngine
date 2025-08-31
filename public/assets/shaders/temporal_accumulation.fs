#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var rawAO: texture_2d<f32>;
@group(0) @binding(1) var aoSampler: sampler;

@group(1) @binding(0) var accAO: texture_2d<f32>;
@group(1) @binding(1) var accSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let AO_current = textureSample(rawAO, aoSampler, uv).x;
    let AO_history = textureSample(accAO, accSampler, uv).x;

    return lerp(AO_current, AO_history, 0.8);
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    return a * (1.0 - t) + b * t;
}