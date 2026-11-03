#include "common/uniforms"
#include "post-processing/temporal_common"

// ---------------------------------------------------------------------------
// TAA — temporal anti-aliasing resolve (compute, render resolution)
// Port of three.js TRAANode (examples/jsm/tsl/display/TRAANode.js), keeping two of this
// engine's improvements: Catmull-Rom history fetch and Reinhard-compressed YCoCg
// variance clipping.
//
//   • velocity of the closest-depth texel in the 3×3 (foreground wins at silhouettes)
//   • disocclusion from the previous frame's depth, reprojected into this frame;
//     geometric edges keep their history (jitter makes them flip every frame)
//   • Salvi variance clipping (mean ± γσ), γ ∈ [0.5, 1] tightening with motion
//   • current weight 0.05 + sub-pixel correction + motion, inverse-luminance blend
//
// Runs on HDR linear colour, before tone mapping.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txCurrent:         texture_2d<f32>;
@group(1) @binding(1) var txHistory:         texture_2d<f32>;
@group(1) @binding(2) var txVelocity:        texture_2d<f32>;
@group(1) @binding(3) var txLinearDepth:     texture_2d<f32>;
@group(1) @binding(4) var txPrevLinearDepth: texture_2d<f32>;
@group(1) @binding(5) var linearSampler:     sampler;
@group(1) @binding(6) var<uniform> params:   TemporalParams;

@group(2) @binding(0) var outputColor: texture_storage_2d<rgba16float, write>;

// Weight boost when the reprojected position falls between history texels, where the
// bilinear/bicubic fetch is blurriest (three.js subpixelCorrection).
fn subpixelCorrection(velocityUV: vec2<f32>, textureSize: vec2<f32>) -> f32 {
    let phase  = abs(fract(velocityUV * textureSize));
    let weight = max(phase, 1.0 - phase);
    return (1.0 - weight.x * weight.y) / 0.75;
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims  = vec2<i32>(textureDimensions(outputColor));
    let texel = vec2<i32>(gid.xy);
    if (texel.x >= dims.x || texel.y >= dims.y) { return; }

    let textureSize = vec2<f32>(dims);
    let uv = (vec2<f32>(texel) + 0.5) / textureSize;
    let currentColor = max(textureLoad(txCurrent, texel, 0), vec4<f32>(0.0));

    // First frame / after resize: seed the history
    if (params.historyValid < 0.5) {
        textureStore(outputColor, texel, vec4<f32>(currentColor.rgb, 1.0));
        return;
    }

    // ── Reprojection ─────────────────────────────────────────────────────────
    let depth = sampleCurrentDepth(texel);
    let offsetUV  = textureLoad(txVelocity, depth.closestTexel, 0).xy;
    let historyUV = uv - offsetUV;

    let previousDepth  = samplePreviousDepth(historyUV);
    let isValidUV      = uvInside(historyUV);
    let isEdge         = depth.farthestDepth - depth.closestDepth > params.edgeDepthDiff * depth.closestDepth;
    let isDisocclusion = depth.closestDepth - previousDepth > params.depthThreshold * depth.closestDepth;
    let hasValidHistory = isValidUV && (isEdge || !isDisocclusion);

    let historyColor = sampleHistoryCatmullRom(historyUV);
    let motionFactor = saturate(length((uv - historyUV) * textureSize) / params.maxVelocityLength);

    // ── Current-frame weight ─────────────────────────────────────────────────
    var currentWeight = params.currentFrameWeight;
    if (params.useSubpixelCorrection > 0.5) {
        currentWeight += subpixelCorrection(offsetUV, textureSize) * 0.25;
    }
    currentWeight = select(1.0, saturate(currentWeight + motionFactor), hasValidHistory);

    // ── Variance clipping (Salvi) in compressed YCoCg ────────────────────────
    var moment1 = vec3<f32>(0.0);
    var moment2 = vec3<f32>(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let t = clamp(texel + vec2<i32>(x, y), vec2<i32>(0), dims - vec2<i32>(1));
            let c = toClipSpace(max(textureLoad(txCurrent, t, 0).rgb, vec3<f32>(0.0)));
            moment1 += c;
            moment2 += c * c;
        }
    }
    let mean = moment1 / 9.0;
    let varianceGamma = mix(0.5, 1.0, (1.0 - motionFactor) * (1.0 - motionFactor));
    let sigma = sqrt(max(moment2 / 9.0 - mean * mean, vec3<f32>(0.0))) * varianceGamma;
    let clipped = clipAABB(toClipSpace(historyColor.rgb), mean - sigma, mean + sigma);
    let clippedHistory = fromClipSpace(clipped);

    let resolved = flickerReduction(currentColor.rgb, clippedHistory, currentWeight);
    textureStore(outputColor, texel, vec4<f32>(resolved, 1.0));
}
