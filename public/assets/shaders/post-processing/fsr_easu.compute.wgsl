// FSR 1.0 — EASU (Edge-Adaptive Spatial Upsampling)
// Upscales from render resolution to canvas/display resolution.
//
// Algorithm: 12-tap Catmull-Rom bicubic reconstruction with per-channel
// min/max clamping that eliminates the ringing artefacts bicubic normally
// produces across sharp edges.  This clamping step is the defining
// property of FSR1 EASU.
//
// 12-tap sample layout (relative to p = floor(inputPos)):
//   .  b  c  .     y = -1  (arm: x positions 0, 1 only)
//   d  e  f  g     y =  0  (full row: x = -1, 0, 1, 2)
//   h  i  j  k     y = +1  (full row: x = -1, 0, 1, 2)
//   .  l  m  .     y = +2  (arm: x positions 0, 1 only)
//
// The fractional sub-pixel position f = (fx, fy) lies inside the [e,f,i,j]
// 2×2 texel quad (the four QUAD samples below).

struct EASUParams {
  inputSize:  vec2<f32>,  // Render resolution (source)
  outputSize: vec2<f32>,  // Canvas/display resolution (destination)
}

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(1) @binding(0) var outputTex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var<uniform>   params: EASUParams;

// Catmull-Rom cubic kernel, alpha = -0.5
fn catr(t: f32) -> f32 {
  let x = abs(t);
  if (x < 1.0) {
    return (1.5 * x - 2.5) * x * x + 1.0;
  } else if (x < 2.0) {
    return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
  }
  return 0.0;
}

fn load(p: vec2<i32>, maxC: vec2<i32>) -> vec4<f32> {
  return textureLoad(inputTex, clamp(p, vec2<i32>(0), maxC), 0);
}

@compute @workgroup_size(8, 8, 1)
fn cs_easu(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outCoord = vec2<i32>(gid.xy);
  let outSize  = vec2<i32>(i32(params.outputSize.x), i32(params.outputSize.y));
  if (outCoord.x >= outSize.x || outCoord.y >= outSize.y) { return; }

  // Map output pixel centre → input space
  // ip is the continuous input position; p is its floor, f is the fractional part.
  let ip  = (vec2<f32>(outCoord) + 0.5) * params.inputSize / params.outputSize - 0.5;
  let p   = vec2<i32>(i32(floor(ip.x)), i32(floor(ip.y)));
  let f   = ip - floor(ip); // sub-pixel offset ∈ [0, 1)²

  let maxC = vec2<i32>(i32(params.inputSize.x) - 1, i32(params.inputSize.y) - 1);

  // ── Load 12 samples ──────────────────────────────────────────────────────
  // y = -1 arm (x = 0, 1)
  let b = load(p + vec2<i32>( 0, -1), maxC);
  let c = load(p + vec2<i32>( 1, -1), maxC);
  // y = 0 full row (x = -1, 0, 1, 2)
  let d = load(p + vec2<i32>(-1,  0), maxC);
  let e = load(p + vec2<i32>( 0,  0), maxC);  // ← QUAD top-left
  let fe = load(p + vec2<i32>( 1,  0), maxC); // ← QUAD top-right  (using 'fe' to avoid keyword clash)
  let g = load(p + vec2<i32>( 2,  0), maxC);
  // y = +1 full row (x = -1, 0, 1, 2)
  let h = load(p + vec2<i32>(-1,  1), maxC);
  let ii = load(p + vec2<i32>( 0,  1), maxC); // ← QUAD bottom-left  ('ii' avoids WGSL built-in)
  let j = load(p + vec2<i32>( 1,  1), maxC);  // ← QUAD bottom-right
  let k = load(p + vec2<i32>( 2,  1), maxC);
  // y = +2 arm (x = 0, 1)
  let l = load(p + vec2<i32>( 0,  2), maxC);
  let m = load(p + vec2<i32>( 1,  2), maxC);

  // ── Catmull-Rom weights ───────────────────────────────────────────────────
  // wx[n] = weight for x position (-1, 0, 1, 2) evaluated at fx
  // wy[n] = weight for y position (-1, 0, 1, 2) evaluated at fy
  let wx = vec4<f32>(
    catr(-1.0 - f.x),   // x = -1
    catr( 0.0 - f.x),   // x =  0
    catr( 1.0 - f.x),   // x =  1
    catr( 2.0 - f.x),   // x =  2
  );
  let wy = vec4<f32>(
    catr(-1.0 - f.y),   // y = -1
    catr( 0.0 - f.y),   // y =  0
    catr( 1.0 - f.y),   // y =  1
    catr( 2.0 - f.y),   // y =  2
  );

  // ── Weighted sum over the 12 available samples ────────────────────────────
  var col = vec4<f32>(0.0);
  col += b  * (wy[0] * wx[1]);
  col += c  * (wy[0] * wx[2]);
  col += d  * (wy[1] * wx[0]);
  col += e  * (wy[1] * wx[1]);
  col += fe * (wy[1] * wx[2]);
  col += g  * (wy[1] * wx[3]);
  col += h  * (wy[2] * wx[0]);
  col += ii * (wy[2] * wx[1]);
  col += j  * (wy[2] * wx[2]);
  col += k  * (wy[2] * wx[3]);
  col += l  * (wy[3] * wx[1]);
  col += m  * (wy[3] * wx[2]);

  // Renormalise: the four missing corner taps (at (x=-1,y=-1), (x=2,y=-1),
  // (x=-1,y=2), (x=2,y=2)) mean the weights no longer sum to 1 exactly.
  let wSum = wy[0] * (              wx[1] + wx[2]              )
           + wy[1] * (wx[0] + wx[1] + wx[2] + wx[3])
           + wy[2] * (wx[0] + wx[1] + wx[2] + wx[3])
           + wy[3] * (              wx[1] + wx[2]              );
  col /= max(wSum, 0.0001);

  // ── Anti-ringing clamp (key FSR1 feature) ─────────────────────────────────
  // Clamp the bicubic result to the convex hull of the 4 immediate neighbours
  // (the QUAD). This suppresses the negative-weight overshoot that Catmull-Rom
  // normally produces across hard edges without sacrificing sharpness on smooth
  // gradients.
  let cMin = min(min(e, fe), min(ii, j));
  let cMax = max(max(e, fe), max(ii, j));
  col = clamp(col, cMin, cMax);

  textureStore(outputTex, outCoord, vec4<f32>(col.rgb, 1.0));
}
