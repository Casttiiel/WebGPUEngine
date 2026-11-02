#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
// Slash alpha mask (tools/vfx/slash_alphas.mjs): X along the trail (head → tail), Y across
// (outer edge → inner side). Bound in the albedo slot.
@group(1) @binding(0) var txAlpha:   texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;

// Textured slash (after Eduardo Braz's "Slash + Mini Tutorial"): the alpha mask decides the
// shape — brush, lines, wisps, shards… — while the outer-edge glow, a little animated shimmer
// and the color ramp dark → tint → white-hot (HDR, for bloom) are shared by every mask.

fn hash1(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash1(i), hash1(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash1(i + vec2<f32>(0.0, 1.0)), hash1(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,   // x = 0 (tip, outer edge) → 1 (hilt, inner), y = 0 (head) → 1 (tail)
    @location(1) color: vec4<f32>,   // cpu-lerped startColor → endColor along the trail
) -> @location(0) vec4<f32> {
    let x = clamp(uv.x, 0.0, 1.0);
    let y = clamp(uv.y, 0.0, 1.0);

    let mask = textureSample(txAlpha, txSampler, vec2<f32>(y, x)).r;

    // Shimmer flowing toward the tail keeps the streaks alive between frames
    let shimmer = 0.75 + 0.25 * vnoise(vec2<f32>(x * 60.0, y * 3.0 - camera.time * 2.5));
    // Brighter toward the outer edge, a hot leading cap at the head
    let across = 0.45 + 0.75 * (1.0 - x) + exp(-x * 22.0) * 0.6;
    let head = 1.0 + exp(-y * 10.0) * 0.6;

    var intensity = mask * shimmer * across * head * color.a;

    // Color ramp: deep tint → saturated tint → white-hot only where the mask peaks
    let tint = color.rgb;
    var col = mix(tint * 0.5, tint * 1.5, smoothstep(0.05, 0.5, intensity));
    col = mix(col, vec3<f32>(1.4) + tint * 0.8, smoothstep(0.9, 1.4, intensity) * 0.45);

    // Blend is additive by source alpha, so the color stays unpremultiplied
    let alpha = clamp(intensity, 0.0, 1.0);
    return vec4<f32>(col, alpha);
}
