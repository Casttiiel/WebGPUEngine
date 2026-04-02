/**
 * TAA — Temporal Anti-Aliasing
 *
 * Pipeline position: after lighting/SSR composition, BEFORE tone mapping (HDR linear).
 *
 * Implements (per TAA.txt plan):
 *  Step 4 — Reprojection via closest-depth velocity dilation (3×3 neighbourhood)
 *  Step 5 — Neighbourhood clamping in YCoCg space (mean ± gamma*stddev)
 *  Step 6 — Adaptive blend factor (motion magnitude + disocclusion + clamp-boost)
 *  Step 7 — Luminance-weighted blend (anti-flicker for specular highlights)
 *  Step 8 — Optional unsharp-mask sharpening after blend
 *
 * Inputs (@group 0 — FourTexture layout):
 *   binding 0: sampler (linear)
 *   binding 1: txCurrent     — current HDR frame
 *   binding 2: txHistory      — previous accumulated result
 *   binding 3: txVelocity     — motion vectors (RG) from VelocityBufferManager
 *   binding 4: txLinearDepth  — linear depth [0..1] from G-Buffer
 *
 * Params (@group 1 — BufferUniform):
 *   blendFactor:     base blend toward current frame (0.1 = 90% history at rest)
 *   sharpenStrength: unsharp-mask intensity after blend (0 = off, 0.3-0.5 = good)
 *   gamma:           variance-clamp std-dev multiplier (1.0–1.5)
 */

@group(0) @binding(0) var txSampler:     sampler;
@group(0) @binding(1) var txCurrent:     texture_2d<f32>;
@group(0) @binding(2) var txHistory:     texture_2d<f32>;
@group(0) @binding(3) var txVelocity:    texture_2d<f32>;
@group(0) @binding(4) var txLinearDepth: texture_2d<f32>;

struct TAAParams {
    blendFactor:     f32,   // base blend toward current (default 0.1)
    sharpenStrength: f32,   // unsharp-mask strength (default 0.3, 0 = off)
    gamma:           f32,   // variance AABB std-dev multiplier (default 1.25)
    _pad:            f32,
}
@group(1) @binding(0) var<uniform> params: TAAParams;

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
}

// ── YCoCg conversion ──────────────────────────────────────────────────────────
// Separating luma (Y) from chroma (Co, Cg) makes the variance AABB tighter and
// more accurate: luminance edges and chroma edges are decorrelated, so the clamping
// bounds are smaller and ghosts are rejected faster without extra flicker.
fn rgbToYCoCg(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
         0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
         0.50 * c.r              - 0.50 * c.b,
        -0.25 * c.r + 0.5 * c.g - 0.25 * c.b,
    );
}

fn yCoCgToRGB(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        c.x + c.y - c.z,
        c.x       + c.z,
        c.x - c.y - c.z,
    );
}

// ── Reinhard luminance compression for AABB clamping ─────────────────────────
// Applied to every sample BEFORE building the neighbourhood AABB.
// A single specular highlight in the 3×3 kernel makes the linear AABB huge,
// letting the history through unclipped; on the next frame the highlight has
// shifted, the bounds tighten and the history gets clamped all the way down
// → flicker.  Compressing through Reinhard keeps all samples in a comparable
// range so the AABB reflects typical neighbourhood colour, not its worst outlier.
fn reinhardTonemap(c: vec3<f32>) -> vec3<f32> {
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    return c / (1.0 + luma);
}

fn reinhardInverse(c: vec3<f32>) -> vec3<f32> {
    // Invert c = orig / (1 + luma_orig).
    // luma_c = luma_orig / (1 + luma_orig)  ⇒  1 + luma_orig = 1 / (1 - luma_c)
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    return c / max(1.0 - luma, 0.0001);
}

// ── Closest-depth velocity dilation (3×3) ────────────────────────────────────
// Foreground objects at object/background boundaries have a different motion
// vector from background pixels directly behind them.  Using the centre pixel's
// velocity for reprojection causes TAA to blend background history onto foreground
// edges → ghost halo when approaching/receding objects.
//
// Fix: pick the velocity of the NEAREST (smallest linear depth) pixel in the 3×3
// kernel.  Foreground surfaces "win" → their velocity is used for both foreground
// AND border pixels, eliminating the halo.
fn closestDepthVelocity(uv: vec2<f32>, texelSize: vec2<f32>) -> vec2<f32> {
    var closestDepth  = 1.0;
    var closestOffset = vec2<f32>(0.0);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let d = textureSampleLevel(txLinearDepth, txSampler, uv + offset, 0.0).r;
            if (d < closestDepth) {
                closestDepth  = d;
                closestOffset = offset;
            }
        }
    }
    return textureSampleLevel(txVelocity, txSampler, uv + closestOffset, 0.0).xy;
}

// ── Depth-edge detection ──────────────────────────────────────────────────────
// Returns [0,1]: 0 = flat surface, 1 = object edge / depth discontinuity.
// Samples all 4 cardinal neighbours (N, S, E, W) so diagonal edges are detected
// as reliably as axis-aligned ones.
fn depthEdgeFactor(uv: vec2<f32>, texelSize: vec2<f32>) -> f32 {
    let depthC = textureSampleLevel(txLinearDepth, txSampler, uv, 0.0).r;
    let depthN = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( 0.0,          texelSize.y), 0.0).r;
    let depthS = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( 0.0,         -texelSize.y), 0.0).r;
    let depthE = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( texelSize.x,  0.0        ), 0.0).r;
    let depthW = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>(-texelSize.x,  0.0        ), 0.0).r;
    let maxDiff = max(max(abs(depthC - depthN), abs(depthC - depthS)),
                     max(abs(depthC - depthE), abs(depthC - depthW)));
    return saturate(maxDiff / max(depthC * 0.05, 0.001));
}

// ── Catmull-Rom bicubic history sample (5-tap bilinear-optimised) ─────────────
// Bilinear history sampling causes accumulated blur: the reprojected position
// rarely lands on a pixel centre, so each frame interpolates 4 neighbours.
// Over many frames the error compounds → ghosting spreads and takes longer to
// converge.  Catmull-Rom has negative lobes (high-pass component), producing a
// sharper history sample and faster ghost convergence.
//
// References: UE4 High-Quality Temporal Supersampling (Karis 2014)
//             Filmic SMAA — Jiménez (CoD) 5-tap corner-omitted optimisation.
fn sampleHistoryCatmullRom(uv: vec2<f32>) -> vec4<f32> {
    let texSize   = vec2<f32>(textureDimensions(txHistory));
    let texelSize = 1.0 / texSize;
    let pos = uv * texSize;
    let tc  = floor(pos - 0.5) + 0.5;
    let f   = pos - tc;

    let w0 = f * (-0.5 + f * ( 1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);

    let w12      = w1 + w2;
    let offset12 = w2 / w12;

    let uv0  = (tc - 1.0      ) * texelSize;
    let uv3  = (tc + 2.0      ) * texelSize;
    let uv12 = (tc + offset12 ) * texelSize;

    var s = vec4<f32>(0.0);
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv0.y),  0.0) * (w12.x * w0.y );
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv0.x,  uv12.y), 0.0) * (w0.x  * w12.y);
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv12.y), 0.0) * (w12.x * w12.y);
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv3.x,  uv12.y), 0.0) * (w3.x  * w12.y);
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv3.y),  0.0) * (w12.x * w3.y );
    return s;
}

// ── Luminance-weighted blend (Karis / UE4 anti-flicker) ──────────────────────
// High-intensity pixels (specular highlights, SSR) can have large frame-to-frame
// variance.  Weighting each input by 1/(1+luma) before blending suppresses the
// influence of outliers and stabilises accumulation.
// Weights are applied explicitly so the blend ratio and the weight ratio stay
// decoupled — the mix() approach via alpha conflates both and is non-linear in
// an unintended way.

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv        = input.Uv;
    let texelSize = vec2<f32>(1.0) / vec2<f32>(textureDimensions(txCurrent));

    // ── 1. Current frame ─────────────────────────────────────────────────────
    let currentColor = textureSample(txCurrent, txSampler, uv);

    // ── 2. Closest-depth velocity → reprojected UV ───────────────────────────
    let velocity  = closestDepthVelocity(uv, texelSize);
    let historyUV = uv - velocity;

    // If the reprojected UV would lie outside the viewport we have no valid history.
    // Return current frame directly (blend = 1.0 implicitly).
    if (historyUV.x < 0.0 || historyUV.x > 1.0 || historyUV.y < 0.0 || historyUV.y > 1.0) {
        return currentColor;
    }

    // ── 3. History sample — Catmull-Rom bicubic ───────────────────────────────
    let historyColor = sampleHistoryCatmullRom(historyUV);

    // ── 4. Neighbourhood AABB clamping in YCoCg (Step 5 of TAA plan) ─────────
    // Collect 3×3 neighbourhood of current frame, compute per-channel mean + variance,
    // clamp history to [mean − γ·σ, mean + γ·σ].
    // YCoCg separates luma from chroma → tighter bounds / better ghost rejection.
    var meanYCoCg = vec3<f32>(0.0);
    var m2YCoCg   = vec3<f32>(0.0);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let c      = textureSampleLevel(txCurrent, txSampler, uv + offset, 0.0);
            // Reinhard-compress before stats: prevents one bright specular pixel
            // from dominating the AABB and causing alternating tight/loose clamping.
            let ycocg  = rgbToYCoCg(reinhardTonemap(c.rgb));
            meanYCoCg += ycocg;
            m2YCoCg   += ycocg * ycocg;
        }
    }
    meanYCoCg /= 9.0;
    let variance     = max(m2YCoCg / 9.0 - meanYCoCg * meanYCoCg, vec3<f32>(0.0));
    let stddev       = sqrt(variance);

    // Clamp history in the same Reinhard+YCoCg space, then restore to linear RGB.
    let histYCoCg    = rgbToYCoCg(reinhardTonemap(historyColor.rgb));
    let colorMin     = meanYCoCg - params.gamma * stddev;
    let colorMax     = meanYCoCg + params.gamma * stddev;
    let clampedYCoCg = clamp(histYCoCg, colorMin, colorMax);
    let clampedHistory = vec4<f32>(reinhardInverse(yCoCgToRGB(clampedYCoCg)), historyColor.a);

    // ── 5. Adaptive blend factor (Step 6 of TAA plan) ────────────────────────
    // - Motion magnitude   → faster convergence during camera/object movement
    // - Depth edge factor  → faster convergence at disocclusion boundaries
    // - Clamping magnitude → large clamp at a *real edge* = disocclusion → boost
    //   (multiplied by edgeFactor so specular-only clamping does NOT trigger this
    //   path — prevents specular highlights from permanently resisting convergence)
    let motionLen     = length(velocity);
    let edgeFactor    = depthEdgeFactor(uv, texelSize);
    let blendMotion   = mix(params.blendFactor, 0.3, saturate(motionLen * 20.0));
    // NOTE: Do NOT boost blend at depth edges (edgeBlend removed).
    // At a static dark/bright edge the AABB spans both sides, so clampDelta ≈ 0 and
    // the only thing driving blend would be edgeFactor — but with jitter the current
    // pixel alternates dark/bright every frame, so any blend > ~0.1 on a static edge
    // produces visible flicker.  Disocclusion (genuinely new geometry) is detected by
    // clampBoost below, which fires when history was clamped far from its raw value
    // (i.e. the background is a very different colour from the now-revealed surface).
    let clampDelta    = length(clampedHistory.rgb - historyColor.rgb);
    let clampBoost    = saturate(clampDelta * 8.0);
    let adaptiveBlend = max(blendMotion, clampBoost * 0.6 * edgeFactor);

    // ── 6. Luminance-weighted blend (Step 7 — anti-flicker) ──────────────────
    // Explicit weight formulation: blend ratios and luma weights are kept separate
    // so the normalisation is linear and well-defined.
    let lumaC  = dot(currentColor.rgb,   vec3<f32>(0.299, 0.587, 0.114));
    let lumaH  = dot(clampedHistory.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let wC     = adaptiveBlend       * (1.0 / (1.0 + lumaC));
    let wH     = (1.0 - adaptiveBlend) * (1.0 / (1.0 + lumaH));
    let wSum   = max(wC + wH, 0.0001);
    var result = vec4<f32>((currentColor.rgb * wC + clampedHistory.rgb * wH) / wSum, 1.0);

    // ── 7. Optional unsharp-mask sharpening (Step 8 of TAA plan) ─────────────
    // Sharpens the blended result, not the raw current frame.  Because a fragment
    // shader cannot read its own output, the 4-tap kernel is built from the centre
    // pixel (result.rgb, already computed) and the 4 neighbours sampled from
    // txCurrent — the per-pixel frequencies of the current frame differ from the
    // accumulated result only by a small amount, so the kernel approximation is
    // good enough in practice and avoids a separate sharpening pass.
    // For a physically exact pass-independent sharpen, use the FSR RCAS stage.
    if (params.sharpenStrength > 0.0) {
        let cn = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( 0.0,           texelSize.y), 0.0).rgb;
        let cs = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( 0.0,          -texelSize.y), 0.0).rgb;
        let ce = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( texelSize.x,   0.0        ), 0.0).rgb;
        let cw = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>(-texelSize.x,   0.0        ), 0.0).rgb;
        // Centre of the blur kernel = blended result (not raw current)
        let blurred   = (result.rgb + cn + cs + ce + cw) * 0.2;
        let sharpened = result.rgb + (result.rgb - blurred) * params.sharpenStrength;
        result = vec4<f32>(max(sharpened, vec3<f32>(0.0)), 1.0);
    }

    return result;
}
