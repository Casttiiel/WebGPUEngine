/**
 * SMAA T2x Temporal Resolve Shader
 *
 * Combina el resultado de SMAA 1x del frame actual con el history buffer.
 *
 * Técnicas implementadas (basadas en "Temporal AA and the Quest for the Holy Trail"):
 * - Variance AABB clamping (mean ± k*stddev) — más agresivo que min/max puro
 * - Closest-depth velocity dilation — elimina halos en bordes foreground/background
 * - Depth-edge adaptive blend — reduce peso del histórico en discontinuidades de profundidad
 * - Catmull-Rom bicubic history sampling — menos blur/ghosting que bilinear (UE4 / CoD)
 * - Luminance weighting — estabiliza especulares brillantes (tono-mapeo inverso antes del blend)
 *
 * Inputs:
 * - Current frame (SMAA 1x result)
 * - History buffer (previous frame result)
 * - Velocity buffer (motion vectors, unjittered)
 * - Linear depth (for closest-depth velocity selection)
 *
 * Output:
 * - Temporally accumulated anti-aliased result
 */

// @group(0) = Input textures (FourTexture layout: sampler first, then textures)
@group(0) @binding(0) var txSampler: sampler;               // Linear sampler
@group(0) @binding(1) var txCurrent: texture_2d<f32>;       // SMAA 1x result (current frame)
@group(0) @binding(2) var txHistory: texture_2d<f32>;       // Previous frame result
@group(0) @binding(3) var txVelocity: texture_2d<f32>;      // Motion vectors (RG)
@group(0) @binding(4) var txLinearDepth: texture_2d<f32>;   // Linear depth (for closest-depth velocity)

// @group(1) = Temporal params
struct TemporalParams {
    jitterOffset: vec2<f32>,      // Unused — kept for buffer layout compatibility
    blendFactor: f32,             // Base blend toward current frame (static-camera quality target)
    clampFactor: f32,             // Unused — kept for buffer layout compatibility
}
@group(1) @binding(0) var<uniform> params: TemporalParams;

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
}

struct NeighborhoodStats {
    mean:   vec4<f32>,
    stddev: vec4<f32>,
}

/**
 * Sample 3x3 neighborhood and compute mean + stddev for variance-based AABB clamping.
 *
 * Variance clamp (Unreal-style):
 *   bounds = [mean - k*stddev, mean + k*stddev]
 *
 * Advantages over pure min/max AABB:
 *   - Flat areas → tight bounds → ghosts are rejected fast
 *   - Edge areas → wider bounds → avoids over-rejection / flickering
 *   - Reduces ghosting during headbob and camera movement
 */
fn computeNeighborhoodStats(uv: vec2<f32>) -> NeighborhoodStats {
    let texelSize = vec2<f32>(1.0) / vec2<f32>(textureDimensions(txCurrent));

    var mean = vec4<f32>(0.0);
    var m2   = vec4<f32>(0.0);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let c = textureSampleLevel(txCurrent, txSampler, uv + offset, 0.0);
            mean += c;
            m2   += c * c;
        }
    }

    mean /= 9.0;
    let variance = max(m2 / 9.0 - mean * mean, vec4<f32>(0.0));
    let stddev   = sqrt(variance);

    return NeighborhoodStats(mean, stddev);
}

/**
 * Closest-depth motion vector (3x3 neighborhood).
 *
 * Foreground objects at object/background boundaries have a different motion
 * vector from the background pixels directly behind them.  Using the center
 * pixel's velocity for reprojection means TAA blends background history onto
 * foreground edges (and vice-versa) → ghost halo when moving toward/away from objects.
 *
 * Fix: pick the velocity of the NEAREST (smallest linear depth) pixel in the
 * 3x3 kernel.  Foreground surfaces "win" → their velocity is used to reproject
 * both the foreground AND the border pixels, eliminating the halo.
 */
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

/**
 * Detect depth discontinuity (object edge) by comparing center depth
 * with its N/E neighbors.  Returns a [0,1] edge factor.
 */
fn depthEdgeFactor(uv: vec2<f32>, texelSize: vec2<f32>) -> f32 {
    let depthC = textureSampleLevel(txLinearDepth, txSampler, uv,                         0.0).r;
    let depthN = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>(0.0,  texelSize.y), 0.0).r;
    let depthE = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>(texelSize.x, 0.0), 0.0).r;
    // Normalise by depth itself so the threshold is view-distance-independent
    let relDiffN = abs(depthC - depthN) / max(depthC, 0.001);
    let relDiffE = abs(depthC - depthE) / max(depthC, 0.001);
    return saturate(max(relDiffN, relDiffE) / 0.05); // smooth ramp over 0..5% relative diff
}

/**
 * Catmull-Rom bicubic filter — 5-tap bilinear-optimized version.
 *
 * Bilinear history sampling causes accumulated blur: the reprojected position
 * rarely lands exactly on a pixel center, so each frame interpolates 4 neighbors.
 * Over many frames the error compounds → ghosting spreads and takes longer to
 * converge.  Catmull-Rom has negative lobes (acts as a high-pass filter), which
 * produces a sharper history sample and faster ghost convergence.
 *
 * References:
 *   UE4 High-Quality Temporal Supersampling (Karis 2014)
 *   Filmic SMAA — Jiménez (Call of Duty) 5-tap corner-omitted optimization
 */
fn sampleHistoryCatmullRom(uv: vec2<f32>) -> vec4<f32> {
    let texSize   = vec2<f32>(textureDimensions(txHistory));
    let texelSize = 1.0 / texSize;

    // Position in texel space; tc = center of the [1,1] texel of a 4×4 kernel
    let pos = uv * texSize;
    let tc  = floor(pos - 0.5) + 0.5;
    let f   = pos - tc;          // fractional offset within the texel

    // Catmull-Rom weight polynomials (evaluated independently per axis)
    let w0 = f * (-0.5 + f * ( 1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);

    // Merge the two center taps [1] and [2] via hardware bilinear
    // → 5 samples instead of 16, at the cost of ignoring the 4 corner samples
    // (corner weights w0*w0, w3*w0, w0*w3, w3*w3 are negligible in practice)
    let w12      = w1 + w2;
    let offset12 = w2 / w12;    // bilinear offset to reproduce w1*s1 + w2*s2

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

/**
 * Inverse-luminance tone-map for temporal stability (Karis / UE4).
 *
 * High-intensity pixels (specular highlights, SSR) can have large frame-to-frame
 * variance.  If they appear/disappear across adjacent frames the color AABB is huge
 * and the variance clamp lets through ghost values.  Weighting by 1/(1+luma) before
 * blending suppresses the influence of outliers and stabilises the accumulation.
 *
 * Usage:
 *   wCurrent = applyLumaWeight(current)         // .a stores the weight
 *   wHistory = applyLumaWeight(clampedHistory)
 *   blended  = mix(wHistory, wCurrent, alpha)
 *   final    = blended.rgb / max(blended.a, ε)  // undo the weight
 */
fn applyLumaWeight(color: vec4<f32>) -> vec4<f32> {
    let luma = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let w    = 1.0 / (1.0 + luma);
    return vec4<f32>(color.rgb * w, w);   // weight carried in alpha for recovery
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv        = input.Uv;
    let texelSize = vec2<f32>(1.0) / vec2<f32>(textureDimensions(txCurrent));

    // 1. Current frame color
    let currentColor = textureSample(txCurrent, txSampler, uv);

    // 2. Closest-depth motion vector — foreground pixel wins in the 3×3 kernel,
    //    so object-edge ghost halos are eliminated when approaching/receding from objects.
    let velocity  = closestDepthVelocity(uv, texelSize);
    let historyUV = uv - velocity;

    // 3. Discard invalid history
    let isHistoryValid = historyUV.x >= 0.0 && historyUV.x <= 1.0 &&
                         historyUV.y >= 0.0 && historyUV.y <= 1.0;
    if (!isHistoryValid) {
        return currentColor;
    }

    // 4. Catmull-Rom bicubic history sample — sharper than bilinear,
    //    reduces the spreading of ghost colors across frames.
    let historyColor = sampleHistoryCatmullRom(historyUV);

    // 5. Variance AABB clamping: clamp to [mean - σ, mean + σ]
    //    Flat areas → tight bounds → ghosts rejected fast.
    //    High-contrast edges → slightly wider bounds → avoids flicker.
    let stats      = computeNeighborhoodStats(uv);
    let gamma      = 0.5;   // std-dev multiplier: 1.0 = permissive, 0.5 = aggressive, 0.0 = no history
    let clampedHistory = clamp(historyColor,
                               stats.mean - gamma * stats.stddev,
                               stats.mean + gamma * stats.stddev);

    // 6. Adaptive blend factor
    //    - motion magnitude    → faster convergence during movement
    //    - depth edge          → faster convergence at object/background boundaries
    //    - clamping event      → large clamp = disocclusion/lighting change → boost further
    let motionLen     = length(velocity);
    let edgeFactor    = depthEdgeFactor(uv, texelSize);
    let blendMotion   = mix(params.blendFactor, 0.3, saturate(motionLen * 20.0));
    let edgeBlend     = mix(blendMotion, 0.5, edgeFactor);

    // Clamp-event detection: if historyColor was far outside the AABB it means a
    // disocclusion, scene cut, or large lighting change.  Boost blend toward current
    // frame so TAA converges in fewer frames instead of ghosting through the change.
    let clampDelta  = length(clampedHistory.rgb - historyColor.rgb);
    let clampBoost  = saturate(clampDelta * 8.0);  // 0 = no clamp, 1 = heavy clamp
    let adaptiveBlend = max(edgeBlend, clampBoost * 0.6);

    // 7. Luminance-weighted blend (tone-map → mix → undo)
    //    Suppresses specular/SSR outliers that destabilise the accumulation buffer.
    let wCurrent        = applyLumaWeight(currentColor);
    let wHistory        = applyLumaWeight(clampedHistory);
    let blendedWeighted = mix(wHistory, wCurrent, adaptiveBlend);

    // Undo the tone-mapping: RGB / blended_weight (stored in alpha)
    return vec4<f32>(blendedWeighted.rgb / max(blendedWeighted.a, 0.0001), 1.0);
}
