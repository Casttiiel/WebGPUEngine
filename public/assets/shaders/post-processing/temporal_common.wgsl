// ---------------------------------------------------------------------------
// Shared helpers for the temporal resolves (taa.cs, tsr.cs).
// Ports of three.js TAAUtils.js (sampleCurrentDepth, samplePreviousDepth, clipAABB,
// flickerReduction) adapted to this engine:
//   • depth is the G-buffer linear depth (distance along cameraFront / cameraFar)
//   • velocity is a UV-space delta (current − previous): historyUV = uv − velocity
// Including shaders must declare: camera, params (TemporalParams), txLinearDepth,
// txPrevLinearDepth, txVelocity, txHistory, linearSampler.
// ---------------------------------------------------------------------------

struct TemporalParams {
    prevInvProjection:     mat4x4<f32>,
    prevInvView:           mat4x4<f32>,
    currentFrameWeight:    f32, // minimum weight of the current frame
    depthThreshold:        f32, // relative linear-depth jump that counts as disocclusion
    edgeDepthDiff:         f32, // relative depth range in the 3×3 that marks a geometric edge
    maxVelocityLength:     f32, // pixels of motion at which the history is fully distrusted
    useSubpixelCorrection: f32, // TAA only
    historyValid:          f32, // 0 on the first frame / after a resize
    _pad0:                 f32,
    _pad1:                 f32,
}

fn temporalLuminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ── Neighbourhood space: Reinhard-compressed YCoCg ───────────────────────────
// Compressing before the moments keeps one bright specular sample from inflating the
// clipping box; YCoCg decorrelates luma and chroma so the box is tighter.
fn toClipSpace(c: vec3<f32>) -> vec3<f32> {
    let r = c / (1.0 + temporalLuminance(c));
    return vec3<f32>(
         0.25 * r.r + 0.5 * r.g + 0.25 * r.b,
         0.50 * r.r              - 0.50 * r.b,
        -0.25 * r.r + 0.5 * r.g - 0.25 * r.b,
    );
}

fn fromClipSpace(y: vec3<f32>) -> vec3<f32> {
    let r = vec3<f32>(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z);
    return r / max(1.0 - temporalLuminance(r), 0.001);
}

// Clip the history toward the box centre (three.js clipAABB / Playdead).
fn clipAABB(history: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec3<f32> {
    let pClip = (boxMax + boxMin) * 0.5;
    let eClip = (boxMax - boxMin) * 0.5 + 1e-7;
    let vClip = history - pClip;
    let absUnit = abs(vClip / eClip);
    let maxUnit = max(absUnit.x, max(absUnit.y, absUnit.z));
    return select(history, pClip + vClip / maxUnit, maxUnit > 1.0);
}

// Inverse-luminance temporal blend (three.js flickerReduction).
fn flickerReduction(currentColor: vec3<f32>, historyColor: vec3<f32>, currentWeight: f32) -> vec3<f32> {
    let compressedCurrent = currentColor / (max(currentColor.r, max(currentColor.g, currentColor.b)) + 1.0);
    let compressedHistory = historyColor / (max(historyColor.r, max(historyColor.g, historyColor.b)) + 1.0);
    let weightCurrent = currentWeight / (temporalLuminance(compressedCurrent) + 1.0);
    let weightHistory = (1.0 - currentWeight) / (temporalLuminance(compressedHistory) + 1.0);
    return (currentColor * weightCurrent + historyColor * weightHistory) / max(weightCurrent + weightHistory, 1e-5);
}

// ── Depth ────────────────────────────────────────────────────────────────────
struct CurrentDepth {
    closestDepth:    f32,
    closestTexel:    vec2<i32>,
    farthestDepth:   f32,
}

// Closest / farthest linear depth in the 3×3 around a texel (velocity dilation + edges).
fn sampleCurrentDepth(texel: vec2<i32>) -> CurrentDepth {
    let dims = vec2<i32>(textureDimensions(txLinearDepth));
    var r: CurrentDepth;
    r.closestDepth = 2.0;
    r.closestTexel = texel;
    r.farthestDepth = -1.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let t = clamp(texel + vec2<i32>(x, y), vec2<i32>(0), dims - vec2<i32>(1));
            let d = textureLoad(txLinearDepth, t, 0).r;
            if (d < r.closestDepth) {
                r.closestDepth = d;
                r.closestTexel = t;
            }
            r.farthestDepth = max(r.farthestDepth, d);
        }
    }
    return r;
}

// Previous frame's surface at historyUV, re-expressed as a CURRENT-frame linear depth,
// so it can be compared with this frame's depth to detect disocclusion.
fn samplePreviousDepth(historyUV: vec2<f32>) -> f32 {
    let dims  = vec2<i32>(textureDimensions(txPrevLinearDepth));
    let texel = clamp(vec2<i32>(floor(historyUV * vec2<f32>(dims))), vec2<i32>(0), dims - vec2<i32>(1));
    let prevLinear = textureLoad(txPrevLinearDepth, texel, 0).r;

    let ndc  = vec2<f32>(historyUV.x * 2.0 - 1.0, (1.0 - historyUV.y) * 2.0 - 1.0);
    let rayH = params.prevInvProjection * vec4<f32>(ndc, 0.5, 1.0);
    let ray  = rayH.xyz / rayH.w;
    let prevView  = ray * ((-prevLinear * camera.cameraFar) / ray.z);
    let worldPos  = (params.prevInvView * vec4<f32>(prevView, 1.0)).xyz;
    let currView  = (camera.viewMatrix * vec4<f32>(worldPos, 1.0)).xyz;
    return -currView.z / camera.cameraFar;
}

fn uvInside(uv: vec2<f32>) -> bool {
    return all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
}

// ── History: Catmull-Rom bicubic (5 bilinear taps) ───────────────────────────
// Sharper than three.js' bilinear history fetch: bilinear resampling blurs the history
// a little every frame and the error compounds over the accumulation.
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
    let uv0  = (tc - 1.0) * texelSize;
    let uv3  = (tc + 2.0) * texelSize;
    let uv12 = (tc + offset12) * texelSize;

    var s = vec4<f32>(0.0);
    s += textureSampleLevel(txHistory, linearSampler, vec2<f32>(uv12.x, uv0.y),  0.0) * (w12.x * w0.y );
    s += textureSampleLevel(txHistory, linearSampler, vec2<f32>(uv0.x,  uv12.y), 0.0) * (w0.x  * w12.y);
    s += textureSampleLevel(txHistory, linearSampler, vec2<f32>(uv12.x, uv12.y), 0.0) * (w12.x * w12.y);
    s += textureSampleLevel(txHistory, linearSampler, vec2<f32>(uv3.x,  uv12.y), 0.0) * (w3.x  * w12.y);
    s += textureSampleLevel(txHistory, linearSampler, vec2<f32>(uv12.x, uv3.y),  0.0) * (w12.x * w3.y );
    return max(s, vec4<f32>(0.0));
}
