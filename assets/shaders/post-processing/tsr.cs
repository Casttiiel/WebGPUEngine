#include "common/uniforms"
#include "post-processing/temporal_common"

// ---------------------------------------------------------------------------
// TSR — temporal super-resolution resolve (compute, OUTPUT resolution)
// Port of three.js TAAUNode (examples/jsm/tsl/display/TAAUNode.js).
//
// The low-resolution input is jittered every frame. Instead of upscaling it as if each
// texel sat at its centre, every output pixel reconstructs the current frame from the 3×3
// input samples around it with a Gaussian weight on their REAL (jittered) positions, so
// successive frames contribute genuinely new sub-pixel detail to the history.
//
//   • velocity / depth fetched unfiltered (no foreground/background velocity mixing)
//   • disocclusion from the previous frame's depth, reprojected into this frame
//   • Salvi variance clipping in compressed YCoCg, γ ∈ [0.5, 1] with motion
//   • "lock": thin features (1 px wires, cracks) keep their unclipped history so they
//     don't flicker; stored in the history alpha and decayed every frame. Only while the
//     history agrees with the current frame and the pixel is still (else it ghosts)
//   • current weight 0.025 + motion, inverse-luminance blend
//
// Output alpha = lock (history only; downstream passes ignore it).
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txCurrent:         texture_2d<f32>; // render resolution
@group(1) @binding(1) var txHistory:         texture_2d<f32>; // output resolution
@group(1) @binding(2) var txVelocity:        texture_2d<f32>; // render resolution
@group(1) @binding(3) var txLinearDepth:     texture_2d<f32>; // render resolution
@group(1) @binding(4) var txPrevLinearDepth: texture_2d<f32>; // render resolution
@group(1) @binding(5) var linearSampler:     sampler;
@group(1) @binding(6) var<uniform> params:   TemporalParams;

@group(2) @binding(0) var outputColor: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outDims = vec2<i32>(textureDimensions(outputColor));
    let pixel   = vec2<i32>(gid.xy);
    if (pixel.x >= outDims.x || pixel.y >= outDims.y) { return; }

    let uv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(outDims);
    let inDims = vec2<i32>(textureDimensions(txCurrent));
    let inputSize = vec2<f32>(inDims);

    // First frame / after resize: seed with a bilinear upscale
    if (params.historyValid < 0.5) {
        let c = textureSampleLevel(txCurrent, linearSampler, uv, 0.0).rgb;
        textureStore(outputColor, pixel, vec4<f32>(max(c, vec3<f32>(0.0)), 0.0));
        return;
    }

    // Where input texel t was actually sampled, in unjittered input-pixel space.
    // The camera shifts the image by (−jx, +jy) pixels (projection[8/9] += 2·offset),
    // so texel t's centre sees the scene at t + 0.5 + (jx, −jy).
    let sampleOffset = camera.jitterOffset * inputSize * vec2<f32>(1.0, -1.0);
    let pIn = uv * inputSize;
    let closestTap = clamp(vec2<i32>(round(pIn - (vec2<f32>(0.5) + sampleOffset))),
                           vec2<i32>(0), inDims - vec2<i32>(1));

    // ── Reprojection ─────────────────────────────────────────────────────────
    let depth = sampleCurrentDepth(closestTap);
    let offsetUV  = textureLoad(txVelocity, depth.closestTexel, 0).xy;
    let historyUV = uv - offsetUV;

    let previousDepth  = samplePreviousDepth(historyUV);
    let isValidUV      = uvInside(historyUV);
    let isEdge         = depth.farthestDepth - depth.closestDepth > params.edgeDepthDiff * depth.closestDepth;
    let isDisocclusion = depth.closestDepth - previousDepth > params.depthThreshold * depth.closestDepth;
    let hasValidHistory = isValidUV && (isEdge || !isDisocclusion);

    // ── Reconstruct the current frame from the jittered 3×3 samples ──────────
    var sumColor  = vec3<f32>(0.0);
    var sumWeight = 0.0;
    var moment1   = vec3<f32>(0.0);
    var moment2   = vec3<f32>(0.0);
    var meanRGB   = vec3<f32>(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let tap = clamp(closestTap + vec2<i32>(x, y), vec2<i32>(0), inDims - vec2<i32>(1));
            let tapCenter = vec2<f32>(closestTap + vec2<i32>(x, y)) + vec2<f32>(0.5) + sampleOffset;
            let delta = pIn - tapCenter;
            let w = exp(-2.29 * dot(delta, delta)); // Gaussian approximation of a Blackman-Harris lobe
            let c = max(textureLoad(txCurrent, tap, 0).rgb, vec3<f32>(0.0));
            sumColor  += c * w;
            sumWeight += w;
            meanRGB   += c;
            let cc = toClipSpace(c);
            moment1 += cc;
            moment2 += cc * cc;
        }
    }
    let currentColor = sumColor / max(sumWeight, 1e-5);
    meanRGB /= 9.0;

    // ── Variance clipping ────────────────────────────────────────────────────
    let motionFactor  = saturate(length((uv - historyUV) * inputSize) / params.maxVelocityLength);
    let varianceGamma = mix(0.5, 1.0, (1.0 - motionFactor) * (1.0 - motionFactor));
    let mean  = moment1 / 9.0;
    let sigma = sqrt(max(moment2 / 9.0 - mean * mean, vec3<f32>(0.0))) * varianceGamma;

    let historyColor   = sampleHistoryCatmullRom(historyUV);
    let clippedHistory = fromClipSpace(clipAABB(toClipSpace(historyColor.rgb), mean - sigma, mean + sigma));

    // ── Lock: protect thin features from clipping-induced flicker ────────────
    let meanLuma    = max(temporalLuminance(meanRGB), 1e-4);
    let thinFeature = smoothstep(0.0, 0.2, abs(temporalLuminance(currentColor) - meanLuma) / meanLuma);
    let isDepthChanged = abs(depth.closestDepth - previousDepth) > params.depthThreshold * depth.closestDepth;
    let canLock = isValidUV && !isDepthChanged;
    // The lock travels with the surface: read it where this pixel was last frame.
    let previousLock = textureSampleLevel(txHistory, linearSampler, historyUV, 0.0).a;
    let decay = select(0.5, 0.0, isDisocclusion);
    // A lock only protects a feature that is in BOTH frames. Particles and silhouettes
    // write no depth/velocity, so the depth test above can't see them move: without this,
    // a spark that left the pixel kept its unclipped history → trails.
    let historyLuma = temporalLuminance(historyColor.rgb);
    let currentLuma = temporalLuminance(currentColor);
    let lumaDiff  = abs(historyLuma - currentLuma) / max(max(historyLuma, currentLuma), 1e-4);
    let agreement = 1.0 - smoothstep(0.25, 0.6, lumaDiff);
    // Motion already hides the flicker the lock is for, and moving edges are where it ghosts.
    let motionPx  = length((uv - historyUV) * inputSize);
    let stillness = 1.0 - smoothstep(0.5, 2.0, motionPx);
    let lock = saturate(max(select(0.0, thinFeature, canLock), previousLock * decay)) * agreement * stillness;
    let lockedHistory = mix(clippedHistory, historyColor.rgb, lock);

    // ── Blend ────────────────────────────────────────────────────────────────
    let currentWeight = select(1.0, saturate(params.currentFrameWeight + motionFactor), hasValidHistory);
    let resolved = flickerReduction(currentColor, lockedHistory, currentWeight);
    textureStore(outputColor, pixel, vec4<f32>(resolved, lock));
}
