// FSR 1.0 — EASU (Edge-Adaptive Spatial Upsampling)
//
// Algorithm: proper edge-adaptive reconstruction matching the AMD FSR1 reference.
// The filter kernel is an AMD-style Lanczos2 approximation whose shape is
// ROTATED to align with the detected edge direction and COMPRESSED across the
// edge to preserve sharpness on geometry boundaries — this is the defining
// difference from plain bicubic reconstruction.
//
// 12-tap sample layout (relative to p = floor(inputPos)):
//   .  b  c  .     y = -1  (arm: x = 0, 1)
//   d  e  f  g     y =  0  (full row: x = -1, 0, 1, 2)
//   h  i  j  k     y = +1  (full row: x = -1, 0, 1, 2)
//   .  l  m  .     y = +2  (arm: x = 0, 1)

struct EASUParams {
    inputSize:    vec2<f32>,  // Render resolution (source)
    outputSize:   vec2<f32>,  // Canvas/display resolution (destination)
    scale:        vec2<f32>,  // inputSize / outputSize  (precomputed on CPU)
    invInputSize: vec2<f32>,  // 1.0 / inputSize         (precomputed on CPU)
}

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(1) @binding(0) var outputTex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var<uniform>   params: EASUParams;

// Cheap luma — AMD FSR1 reference approximation.
fn lumaOf(c: vec3<f32>) -> f32 {
    return 0.5 * c.g + 0.25 * (c.r + c.b);
}

fn loadAt(p: vec2<i32>, maxC: vec2<i32>) -> vec3<f32> {
    return textureLoad(inputTex, clamp(p, vec2<i32>(0), maxC), 0).rgb;
}

// AMD FSR1 anisotropic Lanczos2 approximation — accumulate one tap.
//   off  — pixel offset from the fractional sub-pixel position (unrotated)
//   dir  — gradient direction = edge-perpendicular unit vector
//   len  — (lenAcross, lenAlong): filter scale factors for each axis
//   lob  — negative-lobe amplitude (AMD default: -0.5)
//   clp  — kernel support clip point (= 1.0 / (-lob * 2.0) = 1.0)
fn tap(
    aC: ptr<function, vec3<f32>>,
    aW: ptr<function, f32>,
    off: vec2<f32>,
    dir: vec2<f32>,
    len: vec2<f32>,
    lob: f32,
    clp: f32,
    c:   vec3<f32>,
) {
    // Rotate offset into edge-aligned space:
    //   v.x = component across the edge (along gradient)
    //   v.y = component along  the edge (perpendicular to gradient)
    var v: vec2<f32>;
    v.x = dot(off, vec2<f32>( dir.x,  dir.y));
    v.y = dot(off, vec2<f32>(-dir.y,  dir.x));

    // Anisotropic stretch: compress across edge, normal along edge.
    v *= len;

    // Clip squared distance to kernel support radius.
    let d2 = min(v.x * v.x + v.y * v.y, clp);

    // AMD FSR1 Lanczos2 polynomial approximation.
    // wBf: main lobe shape (positive ≈ d² < 0.25, negative ≈ d² > 0.25)
    // wAs: windowing function that tapers to 0 at d²=clp
    let wB  = (4.0 / 5.0) * d2 - (4.0 / 5.0);
    let wBf = (25.0 / 16.0) * (wB * wB) - (25.0 / 16.0 - 1.0);
    let wA  = lob * d2 - lob;
    let w   = wBf * (wA * wA);

    *aC += c * w;
    *aW += w;
}

@compute @workgroup_size(16, 16, 1)
fn cs_easu(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outCoord = vec2<i32>(gid.xy);
    let outSize  = vec2<i32>(i32(params.outputSize.x), i32(params.outputSize.y));
    if (outCoord.x >= outSize.x || outCoord.y >= outSize.y) { return; }

    let maxC = vec2<i32>(i32(params.inputSize.x) - 1, i32(params.inputSize.y) - 1);

    // Map output pixel centre → input space using precomputed scale (avoids per-pixel division).
    let ip = (vec2<f32>(outCoord) + 0.5) * params.scale - 0.5;
    let p  = vec2<i32>(i32(floor(ip.x)), i32(floor(ip.y)));
    let f  = ip - floor(ip); // sub-pixel offset ∈ [0, 1)²

    // ── Load 12 samples ──────────────────────────────────────────────────────
    let b  = loadAt(p + vec2<i32>( 0, -1), maxC);
    let c  = loadAt(p + vec2<i32>( 1, -1), maxC);
    let d  = loadAt(p + vec2<i32>(-1,  0), maxC);
    let e  = loadAt(p + vec2<i32>( 0,  0), maxC);
    let fe = loadAt(p + vec2<i32>( 1,  0), maxC);  // 'f' is a WGSL keyword
    let g  = loadAt(p + vec2<i32>( 2,  0), maxC);
    let h  = loadAt(p + vec2<i32>(-1,  1), maxC);
    let ii = loadAt(p + vec2<i32>( 0,  1), maxC);  // 'i' is a WGSL built-in
    let j  = loadAt(p + vec2<i32>( 1,  1), maxC);
    let k  = loadAt(p + vec2<i32>( 2,  1), maxC);
    let l  = loadAt(p + vec2<i32>( 0,  2), maxC);
    let m  = loadAt(p + vec2<i32>( 1,  2), maxC);

    let lb  = lumaOf(b);  let lc  = lumaOf(c);
    let ld  = lumaOf(d);  let le  = lumaOf(e);
    let lfe = lumaOf(fe); let lg  = lumaOf(g);
    let lh  = lumaOf(h);  let lii = lumaOf(ii);
    let lj  = lumaOf(j);  let lk  = lumaOf(k);
    let ll  = lumaOf(l);  let lm  = lumaOf(m);

    // ── Edge direction analysis ───────────────────────────────────────────────
    // Compute gradient from the 2×2 center quad plus arm contributions.
    // gx > 0 = brighter on the right; gy > 0 = brighter below.
    let gx = (lfe + lj) - (le + lii)
           + 0.5 * ((lc - lb) + (lk - lh) + (lg - ld) + (lm - ll));
    let gy = (lii + lj) - (le + lfe)
           + 0.5 * ((lb + lc) - (lh + lk) + (ld - lh) + (lg - lk));

    let gMag = max(sqrt(gx * gx + gy * gy), 0.0001);

    // Gradient unit vector — points across the edge (from dark to bright).
    let dir = vec2<f32>(gx, gy) / gMag;

    // ── Anisotropy ────────────────────────────────────────────────────────────
    // Measure how "edge-like" this region is relative to its local contrast.
    let lumaMax   = max(max(le, lfe), max(lii, lj));
    let lumaMin   = min(min(le, lfe), min(lii, lj));
    let edgeRatio = min(gMag / max((lumaMax - lumaMin) * 4.0, 0.0001), 1.0);

    // Compress filter across the edge proportionally to edge strength.
    // lenAcross < 1 → tighter kernel perpendicular to edge → sharper boundary.
    // lenAlong  = 1 → normal reconstruction along the edge.
    let lenAcross = 1.0 / (1.0 + edgeRatio * 2.0);
    let len = vec2<f32>(lenAcross, 1.0);

    // AMD FSR1 standard negative-lobe parameters.
    let lob = -0.5;
    let clp =  1.0; // 1.0 / (-lob * 2.0)

    // ── Accumulate 12 anisotropic taps ───────────────────────────────────────
    var aC = vec3<f32>(0.0);
    var aW = 0.0;

    tap(&aC, &aW, vec2<f32>( 0.0-f.x, -1.0-f.y), dir, len, lob, clp, b);
    tap(&aC, &aW, vec2<f32>( 1.0-f.x, -1.0-f.y), dir, len, lob, clp, c);
    tap(&aC, &aW, vec2<f32>(-1.0-f.x,  0.0-f.y), dir, len, lob, clp, d);
    tap(&aC, &aW, vec2<f32>( 0.0-f.x,  0.0-f.y), dir, len, lob, clp, e);
    tap(&aC, &aW, vec2<f32>( 1.0-f.x,  0.0-f.y), dir, len, lob, clp, fe);
    tap(&aC, &aW, vec2<f32>( 2.0-f.x,  0.0-f.y), dir, len, lob, clp, g);
    tap(&aC, &aW, vec2<f32>(-1.0-f.x,  1.0-f.y), dir, len, lob, clp, h);
    tap(&aC, &aW, vec2<f32>( 0.0-f.x,  1.0-f.y), dir, len, lob, clp, ii);
    tap(&aC, &aW, vec2<f32>( 1.0-f.x,  1.0-f.y), dir, len, lob, clp, j);
    tap(&aC, &aW, vec2<f32>( 2.0-f.x,  1.0-f.y), dir, len, lob, clp, k);
    tap(&aC, &aW, vec2<f32>( 0.0-f.x,  2.0-f.y), dir, len, lob, clp, l);
    tap(&aC, &aW, vec2<f32>( 1.0-f.x,  2.0-f.y), dir, len, lob, clp, m);

    // Normalize by actual accumulated weight — no renormalization error.
    var col = aC / max(aW, 0.0001);

    // ── Anti-ringing clamp ────────────────────────────────────────────────────
    // Clip to convex hull of the 4 nearest input texels.
    // Eliminates negative-lobe overshoot across hard edges.
    let cMin = min(min(e, fe), min(ii, j));
    let cMax = max(max(e, fe), max(ii, j));
    col = clamp(col, cMin, cMax);

    textureStore(outputTex, outCoord, vec4<f32>(col, 1.0));
}

