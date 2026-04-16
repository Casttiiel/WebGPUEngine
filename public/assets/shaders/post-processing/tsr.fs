/**
 * TSR — Temporal Super-Resolution / Upscaling
 *
 * Replaces both TAA and FSR in the post-processing chain: renders the 3D scene at
 * a lower internal resolution and produces output at full canvas resolution by
 * combining Catmull-Rom reconstruction (spatial) with temporal accumulation.
 *
 * Pipeline position: BEFORE tone mapping (HDR linear space), same slot as TAA.
 * Output is always at canvas resolution, so FSR is no longer needed after this.
 *
 * Key differences vs taa.fs:
 *  - txCurrent     is at RENDER resolution (potentially lower than canvas)
 *  - txHistory     is at CANVAS resolution (accumulated over time)
 *  - txVelocity    is at RENDER resolution
 *  - txLinearDepth is at RENDER resolution
 *  - sampleCurrentCatmullRom() upsamples txCurrent via Catmull-Rom (quality upscaling)
 *  - Neighbourhood AABB and velocity dilation use inputTexelSize (render res)
 *  - When renderResolution == 1.0 this degrades gracefully to full-res TAA quality
 *
 * Inputs (@group 0 — FourTexture layout):
 *   binding 0: sampler (linear)
 *   binding 1: txCurrent     — current HDR frame at render resolution
 *   binding 2: txHistory     — previous accumulated result at canvas resolution
 *   binding 3: txVelocity    — motion vectors (RG) from VelocityBufferManager (render res)
 *   binding 4: txLinearDepth — linear depth [0..1] from G-Buffer (render res)
 *
 * Params (@group 1 — BufferUniform):
 *   blendFactor:     base blend toward current frame (0.1 = 90% history at rest)
 *   sharpenStrength: unsharp-mask intensity after blend (0 = off)
 *   gamma:           variance-clamp std-dev multiplier (1.0–1.5)
 */

@group(0) @binding(0) var txSampler:     sampler;
@group(0) @binding(1) var txCurrent:     texture_2d<f32>;  // render resolution
@group(0) @binding(2) var txHistory:     texture_2d<f32>;  // canvas resolution
@group(0) @binding(3) var txVelocity:    texture_2d<f32>;  // render resolution
@group(0) @binding(4) var txLinearDepth: texture_2d<f32>;  // render resolution

struct TSRParams {
    blendFactor:     f32,   // base blend toward current (default 0.1)
    sharpenStrength: f32,   // unsharp-mask strength (default 0.3, 0 = off)
    gamma:           f32,   // variance AABB std-dev multiplier (default 1.25)
    _pad:            f32,
}
@group(1) @binding(0) var<uniform> params: TSRParams;

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
}

// ── YCoCg conversion ──────────────────────────────────────────────────────────
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
fn reinhardTonemap(c: vec3<f32>) -> vec3<f32> {
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    return c / (1.0 + luma);
}

fn reinhardInverse(c: vec3<f32>) -> vec3<f32> {
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    return c / max(1.0 - luma, 0.0001);
}

// ── Variance clipping (center→history ray clip) ───────────────────────────────
fn varianceClip(history: vec3<f32>, colorMin: vec3<f32>, colorMax: vec3<f32>) -> vec3<f32> {
    let center  = (colorMin + colorMax) * 0.5;
    let extents = (colorMax - colorMin) * 0.5 + vec3<f32>(0.0001);
    let vUnit   = (history - center) / extents;
    let maxA    = max(abs(vUnit.x), max(abs(vUnit.y), abs(vUnit.z)));
    if (maxA > 1.0) { return center + (vUnit / maxA) * extents; }
    return history;
}

// ── Closest-depth velocity dilation (3×3 in render-res space) ────────────────
// Uses inputTexelSize (render res) for depth/velocity texture offsets.
fn closestDepthVelocity(uv: vec2<f32>, inputTexelSize: vec2<f32>) -> vec2<f32> {
    var closestDepth  = 1.0;
    var closestOffset = vec2<f32>(0.0);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * inputTexelSize;
            let d = textureSampleLevel(txLinearDepth, txSampler, uv + offset, 0.0).r;
            if (d < closestDepth) {
                closestDepth  = d;
                closestOffset = offset;
            }
        }
    }
    return textureSampleLevel(txVelocity, txSampler, uv + closestOffset, 0.0).xy;
}

// ── Depth-edge detection (render-res texelSize) ───────────────────────────────
fn depthEdgeFactor(uv: vec2<f32>, inputTexelSize: vec2<f32>) -> f32 {
    let depthC = textureSampleLevel(txLinearDepth, txSampler, uv, 0.0).r;
    let depthN = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( 0.0,               inputTexelSize.y), 0.0).r;
    let depthS = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( 0.0,              -inputTexelSize.y), 0.0).r;
    let depthE = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>( inputTexelSize.x,  0.0             ), 0.0).r;
    let depthW = textureSampleLevel(txLinearDepth, txSampler, uv + vec2<f32>(-inputTexelSize.x,  0.0             ), 0.0).r;
    let maxDiff = max(max(abs(depthC - depthN), abs(depthC - depthS)),
                     max(abs(depthC - depthE), abs(depthC - depthW)));
    return saturate(maxDiff / max(depthC * 0.05, 0.001));
}

// ── Catmull-Rom upsampling of current frame (render res → canvas res) ─────────
// The reconstruction basis is txCurrent's own dimensions (render res), so the
// filter's negative lobes preserve edge sharpness despite the resolution jump.
// 5-tap corner-omitted optimisation (Filmic SMAA, Jiménez / Karis UE4 paper).
fn sampleCurrentCatmullRom(uv: vec2<f32>) -> vec4<f32> {
    let texSize   = vec2<f32>(textureDimensions(txCurrent));
    let texelSize = 1.0 / texSize;
    let pos = uv * texSize;
    let tc  = floor(pos - 0.5) + 0.5;
    let f   = pos - tc;

    // Catmull-Rom weights
    let w0 = f * (f * (-0.5 * f + 1.0) - 0.5);
    let w1 = f * f * (1.5 * f - 2.5) + 1.0;
    let w2 = f * (f * (-1.5 * f + 2.0) + 0.5);
    let w3 = f * f * (0.5 * f - 0.5);

    // Merge inner taps into a single bilinear sample per axis
    let w12    = w1 + w2;
    let offset = w2 / w12;

    let uv0  = (tc - 1.0) * texelSize;
    let uv3  = (tc + 2.0) * texelSize;
    let uv12 = (tc + offset) * texelSize;

    var s = vec4<f32>(0.0);
    s += textureSampleLevel(txCurrent, txSampler, vec2<f32>(uv12.x, uv0.y ), 0.0) * w12.x * w0.y;
    s += textureSampleLevel(txCurrent, txSampler, vec2<f32>(uv0.x,  uv12.y), 0.0) * w0.x  * w12.y;
    s += textureSampleLevel(txCurrent, txSampler, vec2<f32>(uv12.x, uv12.y), 0.0) * w12.x * w12.y;
    s += textureSampleLevel(txCurrent, txSampler, vec2<f32>(uv3.x,  uv12.y), 0.0) * w3.x  * w12.y;
    s += textureSampleLevel(txCurrent, txSampler, vec2<f32>(uv12.x, uv3.y ), 0.0) * w12.x * w3.y;
    return s;
}

// ── Catmull-Rom bicubic history sample (canvas res, 5-tap bilinear-optimised) ──
fn sampleHistoryCatmullRom(uv: vec2<f32>) -> vec4<f32> {
    let texSize   = vec2<f32>(textureDimensions(txHistory));
    let texelSize = 1.0 / texSize;
    let pos = uv * texSize;
    let tc  = floor(pos - 0.5) + 0.5;
    let f   = pos - tc;

    let w0 = f * (f * (-0.5 * f + 1.0) - 0.5);
    let w1 = f * f * (1.5 * f - 2.5) + 1.0;
    let w2 = f * (f * (-1.5 * f + 2.0) + 0.5);
    let w3 = f * f * (0.5 * f - 0.5);

    let w12    = w1 + w2;
    let offset = w2 / w12;

    let uv0  = (tc - 1.0) * texelSize;
    let uv3  = (tc + 2.0) * texelSize;
    let uv12 = (tc + offset) * texelSize;

    var s = vec4<f32>(0.0);
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv0.y ), 0.0) * w12.x * w0.y;
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv0.x,  uv12.y), 0.0) * w0.x  * w12.y;
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv12.y), 0.0) * w12.x * w12.y;
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv3.x,  uv12.y), 0.0) * w3.x  * w12.y;
    s += textureSampleLevel(txHistory, txSampler, vec2<f32>(uv12.x, uv3.y ), 0.0) * w12.x * w3.y;
    return s;
}

@fragment
fn fs(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.Uv;

    // Texel size of the current (render-res) frame — used for all render-res ops
    let inputTexelSize = 1.0 / vec2<f32>(textureDimensions(txCurrent));

    // ── 1. Current frame — Catmull-Rom upsampled from render res ──────────────
    let currentColor = sampleCurrentCatmullRom(uv);

    // ── 2. Reprojection via closest-depth velocity dilation (render-res 3×3) ──
    let velocity  = closestDepthVelocity(uv, inputTexelSize);
    let historyUV = uv - velocity;

    // Return current frame directly when reprojection exits the screen
    if (historyUV.x < 0.0 || historyUV.x > 1.0 || historyUV.y < 0.0 || historyUV.y > 1.0) {
        return currentColor;
    }

    // ── 3. History sample — Catmull-Rom bicubic at canvas res ─────────────────
    let historyColor = sampleHistoryCatmullRom(historyUV);

    // ── 4. Variance clipping in Reinhard+YCoCg space ──────────────────────────
    // Build the neighbourhood AABB from the render-res current frame.
    // Cross+3×3 averaged bounds + adaptive expansion (same method as taa.fs).
    var meanYCoCg = vec3<f32>(0.0);
    var m2YCoCg   = vec3<f32>(0.0);
    var minCross  = vec3<f32>( 1e9);
    var maxCross  = vec3<f32>(-1e9);
    var min3x3    = vec3<f32>( 1e9);
    var max3x3    = vec3<f32>(-1e9);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * inputTexelSize;
            let c      = textureSampleLevel(txCurrent, txSampler, uv + offset, 0.0);
            let ycocg  = rgbToYCoCg(reinhardTonemap(c.rgb));
            meanYCoCg += ycocg;
            m2YCoCg   += ycocg * ycocg;
            min3x3     = min(min3x3, ycocg);
            max3x3     = max(max3x3, ycocg);
            if (abs(x) + abs(y) <= 1) {
                minCross = min(minCross, ycocg);
                maxCross = max(maxCross, ycocg);
            }
        }
    }
    meanYCoCg /= 9.0;
    let variance = max(m2YCoCg / 9.0 - meanYCoCg * meanYCoCg, vec3<f32>(0.0));
    let stddev   = sqrt(variance);

    // Cross+3×3 averaged base bounds
    let rawColorMin  = (minCross + min3x3) * 0.5;
    let rawColorMax  = (maxCross + max3x3) * 0.5;

    // Adaptive expansion at contrast edges
    let colorRange   = length(rawColorMax - rawColorMin);
    let contrastEdge = saturate(colorRange * 2.0);
    let colorMin     = rawColorMin - contrastEdge * stddev * params.gamma;
    let colorMax     = rawColorMax + contrastEdge * stddev * params.gamma;

    let histYCoCg      = rgbToYCoCg(reinhardTonemap(historyColor.rgb));
    let clampedYCoCg   = varianceClip(histYCoCg, colorMin, colorMax);
    let clampedHistory = vec4<f32>(reinhardInverse(yCoCgToRGB(clampedYCoCg)), historyColor.a);

    // ── 5. Adaptive blend factor ───────────────────────────────────────────────
    // clampBoost is gated by motion: at a sub-pixel thin edge (e.g. door crack)
    // jitter causes the pixel to alternate colours every frame in a static scene,
    // making clampDelta large and triggering the disocclusion boost every frame →
    // visible oscillation.  Real disocclusion always has non-trivial velocity, so
    // gating by disoccMotion eliminates the artifact without harming real events.
    let motionLen     = length(velocity);
    let edgeFactor    = depthEdgeFactor(uv, inputTexelSize);
    let blendMotion   = mix(params.blendFactor, 0.3, saturate(motionLen * 20.0));
    let clampDelta    = length(clampedHistory.rgb - historyColor.rgb);
    let clampBoost    = saturate(clampDelta * 8.0);
    let disoccMotion  = saturate(motionLen * 30.0);
    // Thin-feature protection: high neighbourhood stddev signals a complex or sub-pixel
    // feature (1px crack, thin wire, geometry edge) that jitter alternates every frame.
    // Reducing the current-frame blend weight at these pixels bounds the per-frame
    // oscillation amplitude — with blend=0.04 the steady-state shimmer is only ~2% of
    // the colour difference, which is imperceptible.  Ghost convergence slows at these
    // pixels but they are typically too thin to ghost visibly anyway.
    let thinFeatureProtect = saturate(length(stddev) * 5.0 - 0.2);
    let clampBoostTerm = clampBoost * 0.6 * edgeFactor * disoccMotion
                         * (1.0 - thinFeatureProtect * 0.6);
    let adaptiveBlend  = max(blendMotion, clampBoostTerm);

    // ── 6. Luminance-weighted blend (anti-flicker for specular highlights) ─────
    let lumaC  = dot(currentColor.rgb,   vec3<f32>(0.299, 0.587, 0.114));
    let lumaH  = dot(clampedHistory.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let wC     = adaptiveBlend         * (1.0 / (1.0 + lumaC));
    let wH     = (1.0 - adaptiveBlend) * (1.0 / (1.0 + lumaH));
    let wSum   = max(wC + wH, 0.0001);
    var result = vec4<f32>((currentColor.rgb * wC + clampedHistory.rgb * wH) / wSum, 1.0);

    // ── 7. Optional unsharp-mask sharpening (samples txCurrent at render res) ──
    if (params.sharpenStrength > 0.0) {
        let cn = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( 0.0,               inputTexelSize.y), 0.0).rgb;
        let cs = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( 0.0,              -inputTexelSize.y), 0.0).rgb;
        let ce = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>( inputTexelSize.x,  0.0             ), 0.0).rgb;
        let cw = textureSampleLevel(txCurrent, txSampler, uv + vec2<f32>(-inputTexelSize.x,  0.0             ), 0.0).rgb;
        let blurred   = (result.rgb + cn + cs + ce + cw) * 0.2;
        let sharpened = result.rgb + (result.rgb - blurred) * params.sharpenStrength;
        result = vec4<f32>(max(sharpened, vec3<f32>(0.0)), 1.0);
    }

    return result;
}
