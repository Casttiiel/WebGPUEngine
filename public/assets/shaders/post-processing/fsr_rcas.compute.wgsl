// FSR 1.0 — RCAS (Robust Contrast-Adaptive Sharpening)
// Applies edge-aware sharpening at canvas/display resolution.
// Runs after EASU on its output texture.
//
// Algorithm:
//   1. 5-tap cross neighbourhood (N, S, W, E, centre).
//   2. Compute neighbourhood luma range.
//   3. Derive a negative "neighbour weight" that is:
//      - proportional to the requested sharpness (exp2(-sharpness))
//      - adaptively reduced in low-contrast regions (avoids noise amplification)
//      - never below -0.25 (prevents over-sharpening / ringing)
//   4. Blend: result = (centre + neighbours * negW) / (1 + 4*negW)
//   5. Clamp per-channel to neighbourhood min/max.
//
// `sharpness` param: 0 = maximum sharpening, 2 = very gentle.

struct RCASParams {
  sharpness: f32,
  _pad0:     f32,
  _pad1:     f32,
  _pad2:     f32,
}

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(1) @binding(0) var outputTex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var<uniform>   params: RCASParams;

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8, 1)
fn cs_rcas(@builtin(global_invocation_id) gid: vec3<u32>) {
  let coord   = vec2<i32>(gid.xy);
  let texSize = vec2<i32>(textureDimensions(inputTex));
  if (coord.x >= texSize.x || coord.y >= texSize.y) { return; }

  let maxC = texSize - vec2<i32>(1);

  // ── Load 5-tap cross ──────────────────────────────────────────────────────
  let n  = textureLoad(inputTex, clamp(coord + vec2<i32>( 0, -1), vec2<i32>(0), maxC), 0).rgb;
  let s  = textureLoad(inputTex, clamp(coord + vec2<i32>( 0,  1), vec2<i32>(0), maxC), 0).rgb;
  let ww = textureLoad(inputTex, clamp(coord + vec2<i32>(-1,  0), vec2<i32>(0), maxC), 0).rgb;
  let e  = textureLoad(inputTex, clamp(coord + vec2<i32>( 1,  0), vec2<i32>(0), maxC), 0).rgb;
  let mc = textureLoad(inputTex, coord, 0).rgb;

  // ── Luma-contrast range ───────────────────────────────────────────────────
  let lumaM   = luma(mc);
  let lumaN   = luma(n);
  let lumaS   = luma(s);
  let lumaW   = luma(ww);
  let lumaE   = luma(e);

  let lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaW, lumaE)));
  let lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaW, lumaE)));
  let lumaRange = lumaMax - lumaMin;

  // ── Adaptive negative neighbour weight ────────────────────────────────────
  // sharpAmt: full desired sharpening factor, in [0, 1] for sharpness ∈ [0, ∞)
  let sharpAmt = exp2(-params.sharpness); // sharpness=0 → 1.0,  sharpness=2 → 0.25
  // Divide by (4 * lumaRange) so the filter becomes neutral in flat regions.
  // Clamp to [-0.25, 0] so we never invert the kernel.
  let negW = max(-0.25, min(0.0, -sharpAmt / max(4.0 * lumaRange, 0.0001)));

  // ── Sharpening blend ──────────────────────────────────────────────────────
  let result = (mc + (n + s + ww + e) * negW) / (1.0 + 4.0 * negW);

  // ── Per-channel neighbourhood clamp to prevent ringing ────────────────────
  let cMin = min(mc, min(min(n, s), min(ww, e)));
  let cMax = max(mc, max(max(n, s), max(ww, e)));

  textureStore(outputTex, coord, vec4<f32>(clamp(result, cMin, cMax), 1.0));
}
