#include "common/uniforms"

// ── Cyanilux sword slash — adapted for ribbon trail UVs ─────────────────────
//
// Textures (set via material JSON):
//   txAlbedo  (binding 0) — triangle/wedge slash mask  (bright centre, dark edges)
//   txNormal  (binding 1) — seamless tiling noise
//
// UV convention (from TrailRendererComponent):
//   uv.x = 0 (tip/posA) → 1 (hilt/posB)    across the blade
//   uv.y = 0 (newest)   → 1 (oldest/tail)   along the arc
//
// The Cyanilux "Slash" pan maps to our uv.y: the trail geometry already
// handles the reveal (nodes age out), so we sample the texture directly.

@group(0) @binding(0) var<uniform> camera:    CameraUniforms;
@group(1) @binding(0) var txSlash:   texture_2d<f32>;   // slash shape mask
@group(1) @binding(1) var txNoise:   texture_2d<f32>;   // seamless noise
@group(1) @binding(5) var txSampler: sampler;

// ── Tunable constants ────────────────────────────────────────────────────────
const INTENSITY:   f32        = 22.0;
const STEP_A:      f32        = 0.0;
const STEP_B:      f32        = 0.08;
const NOISE_SPEED: f32        = 2.2;
const NOISE_TILE:  vec2<f32>  = vec2<f32>(2.5, 2.5);
// Edge scale: higher = tighter mask (more of the quad corners are cut off).
// Cyanilux uses (2.7, 2.0) on a centred UV; we clamp Y to tail-only fade.
const EDGE_SCALE_X: f32 = 2.6;
// ─────────────────────────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,
    @location(1) color: vec4<f32>,
) -> @location(0) vec4<f32> {

    // ── Slash mask texture ────────────────────────────────────────────────
    // Swap axes: our uv.x is the "depth" (across blade) and uv.y the "arc".
    // Sampling with (uv.y, uv.x) maps a horizontal slash shape onto the arc.
    let slashUV    = vec2<f32>(uv.y, uv.x);
    let slashSample = textureSample(txSlash, txSampler, slashUV).r;

    // ── Edge fade mask (Cyanilux core formula) ────────────────────────────
    // abs(UV − 0.5) × scale → one_minus → saturate → multiply R × G
    let edgeX = saturate(1.0 - abs(uv.x * 2.0 - 1.0) * EDGE_SCALE_X);  // blade edge fade
    let edgeY = saturate(1.0 - uv.y * 1.05);                             // tail fade (not centred)
    let edgeMask = edgeX * edgeY;

    // ── Noise texture (scrolling along arc) ──────────────────────────────
    let noiseUV     = fract(uv * NOISE_TILE + vec2<f32>(-camera.time * NOISE_SPEED, 0.0));
    let noiseSample = textureSample(txNoise, txSampler, noiseUV).r;

    // ── Combine (Cyanilux node graph) ────────────────────────────────────
    // slashMask × edgeMask × noise × intensity → smoothstep → lerp A↔B
    let combined = slashSample * edgeMask * noiseSample * INTENSITY;
    let alpha    = smoothstep(STEP_A, STEP_B, combined);

    // Color A = CPU startColor tint (head) → endColor (tail)
    // Color B = white (bright core at peak intensity)
    let col = mix(color.rgb, vec3<f32>(1.0), alpha);

    return vec4<f32>(col, alpha * color.a);
}
