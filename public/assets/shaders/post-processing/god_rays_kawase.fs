#include "common/uniforms"

// ─── God Rays Kawase Blur ─────────────────────────────────────────────────────
//
// Step 3 of the screen-space god rays pipeline.
//
// Classic Kawase blur: 4 diagonal taps at (±0.5 + offset) × texelSize.
// Run 5 times in ping-pong with offsets 0, 1, 2, 2, 3 to smooth the
// banding artefacts produced by the 64-sample radial march in Step 2.
//
// texelSize is computed from the actual texture dimensions — no extra
// uniform needed.
//
// Bind-group layout
//   group(0)  CameraUniforms              (standard engine binding)
//   group(1)  Ping-pong input + sampler   (SingleTexture)
//   group(2)  KawaseParams uniform        (KawaseUniforms)

// ─── Uniform struct ───────────────────────────────────────────────────────────
// 16 bytes — 4 × f32 for WebGPU uniform buffer alignment.
struct KawaseParams {
    offset: f32,   // Kawase step offset k (pre-written per-pass buffer)
    _pad0:  f32,
    _pad1:  f32,
    _pad2:  f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Ping-pong input (group 1 — SingleTexture layout)
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

// Kawase step params (group 2)
@group(2) @binding(0) var<uniform> params: KawaseParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let dims      = textureDimensions(inputTexture);
    let texelSize = vec2<f32>(1.0 / f32(dims.x), 1.0 / f32(dims.y));

    // Half-pixel offset: (k + 0.5) × texelSize
    let h = (params.offset + 0.5) * texelSize;

    let a = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>( h.x,  h.y), 0.0);
    let b = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>(-h.x,  h.y), 0.0);
    let c = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>( h.x, -h.y), 0.0);
    let d = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>(-h.x, -h.y), 0.0);

    return (a + b + c + d) * 0.25;
}
