// ---------------------------------------------------------------------------
// SSR temporal reprojection — compute shader
// Port of three.js TemporalReprojectNode (mode 'specular', accumulate: false). It only
// reprojects and clips the history (= last frame's denoiser output); the temporal blend
// with the current frame happens in ssr_denoise.cs, as in the three.js example.
//
//   • 3×3 neighbourhood of the raw SSR: YCoCg moments (variance clipping) + ray-length stats
//   • history fetched twice: at the surface reprojection and at the reflected hit point
//     (parallax: surface + cameraRay · rayLength), each a 4-tap bilinear with plane/normal
//     confidence against the previous frame's depth/normals
//   • YCoCg variance clipping with motion-adaptive gamma, stretch / curvature / ray-length
//     edge confidences, frame count in alpha (1 / frames)
//
// Differences from three.js: the surface reprojection uses the previous view-projection
// on the reconstructed position (camera motion) instead of the velocity buffer, which is
// generated after the deferred pass in this engine; screen-space derivatives (fwidth/dFdx)
// are replaced by forward differences since this runs as a compute shader.
//
// Output (rgba16float): rgb = reprojected + clipped history, a = 1 / frameCount.
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/octahedral"
#include "post-processing/ssr_common"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var ssrRaw:          texture_2d<f32>;
@group(2) @binding(1) var<uniform> params: SSRTraceParams;
@group(2) @binding(2) var historyTex:      texture_2d<f32>;
@group(2) @binding(3) var prevLinearDepth: texture_2d<f32>;
@group(2) @binding(4) var prevNormals:     texture_2d<f32>;

@group(3) @binding(0) var outputAccum: texture_storage_2d<rgba16float, write>;

const EPSILON: f32 = 1e-5;
const MAX_VELOCITY_LENGTH: f32 = 128.0;
const VARIANCE_GAMMA_MIN: f32 = 0.5;
const VARIANCE_GAMMA_MAX: f32 = 1.0;
const VARIANCE_CLIP_LUMA_SCALE: f32 = 10.0;

// ── Colour helpers ───────────────────────────────────────────────────────────
fn rgbToYCoCg(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(c, vec3<f32>(0.25, 0.5, 0.25)),
                     dot(c, vec3<f32>(0.5, 0.0, -0.5)),
                     dot(c, vec3<f32>(-0.25, 0.5, -0.25)));
}

fn ycocgToRGB(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// Inverse-luminance compression for HDR variance clipping (Karis-style).
fn dampenForVarianceClip(rgb: vec3<f32>) -> vec3<f32> {
    return rgb / (ssrLuminance(rgb) * params.flickerSuppression * VARIANCE_CLIP_LUMA_SCALE + 1.0);
}

fn clipToAABB(history: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec3<f32> {
    let pClip = (boxMax + boxMin) * 0.5;
    let eClip = (boxMax - boxMin) * 0.5 + 1e-7;
    let vClip = history - pClip;
    let absUnit = abs(vClip / eClip);
    let maxUnit = max(absUnit.x, max(absUnit.y, absUnit.z));
    return select(history, pClip + vClip / maxUnit, maxUnit > 1.0);
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
fn worldPositionAt(uv: vec2<f32>) -> vec3<f32> {
    let vp = ssrViewPosition(uv, ssrSampleDepth(uv));
    return (camera.invView * vec4<f32>(vp, 1.0)).xyz;
}

fn worldNormalAt(uv: vec2<f32>) -> vec3<f32> {
    return octahedral01ToNormal(textureLoad(gNormals, ssrGBufferCoord(gNormals, uv), 0).xy);
}

// ── Neighbourhood (3×3 over the raw SSR) ─────────────────────────────────────
struct Neighborhood {
    mean:            vec3<f32>,
    stdColor:        vec3<f32>,
    rayLength:       f32,
    envProbability:  f32,
    stdDevRayLength: f32,
}

fn collectNeighborhood(texel: vec2<i32>, inputColor: vec4<f32>, dims: vec2<i32>) -> Neighborhood {
    let center  = rgbToYCoCg(dampenForVarianceClip(inputColor.rgb));
    var moment1 = center;
    var moment2 = center * center;
    var rayLengthSum   = 0.0;
    var rayLengthCount = 0.0;
    var meanRayLength  = 0.0;
    var m2RayLength    = 0.0;

    for (var k = 0; k < 9; k++) {
        let o = vec2<i32>(k % 3 - 1, k / 3 - 1);
        var sample = inputColor;
        if (o.x != 0 || o.y != 0) {
            let c = clamp(texel + o, vec2<i32>(0), dims - vec2<i32>(1));
            sample = max(textureLoad(ssrRaw, c, 0), vec4<f32>(0.0));
            let ycocg = rgbToYCoCg(dampenForVarianceClip(sample.rgb));
            moment1 += ycocg;
            moment2 += ycocg * ycocg;
        }
        // Welford ray-length statistics over screen-space hits only
        if (sample.a < ENV_RAY_LENGTH_THRESHOLD) {
            rayLengthSum   += sample.a;
            rayLengthCount += 1.0;
            let delta = sample.a - meanRayLength;
            meanRayLength += delta / rayLengthCount;
            m2RayLength   += delta * (sample.a - meanRayLength);
        }
    }

    var n: Neighborhood;
    n.mean     = moment1 / 9.0;
    n.stdColor = sqrt(max(moment2 / 9.0 - n.mean * n.mean, vec3<f32>(0.0)));
    n.envProbability  = 1.0 - rayLengthCount / 9.0;
    n.rayLength       = select(rayLengthSum / max(rayLengthCount, 1e-4), ENV_RAY_LENGTH, rayLengthCount < 0.5);
    n.stdDevRayLength = max(sqrt(m2RayLength / max(rayLengthCount, 1.0)), 1e-3);
    return n;
}

// ── History sampling ─────────────────────────────────────────────────────────
struct HistoryTap {
    color:      vec4<f32>,
    weight:     f32,
    confidence: f32,
}

fn sampleBilinearTap(tapCoord: vec2<i32>, bilinearWeight: f32, dims: vec2<i32>,
                     worldPosition: vec3<f32>, worldNormal: vec3<f32>) -> HistoryTap {
    var tap: HistoryTap;
    if (any(tapCoord < vec2<i32>(0)) || any(tapCoord >= dims)) {
        tap.color = vec4<f32>(0.0);
        tap.weight = 0.0;
        tap.confidence = 0.0;
        return tap;
    }
    let color = max(textureLoad(historyTex, tapCoord, 0), vec4<f32>(0.0));
    let tapUv = (vec2<f32>(tapCoord) + 0.5) / vec2<f32>(dims);

    let reprojDepth    = textureLoad(prevLinearDepth, ssrGBufferCoord(prevLinearDepth, tapUv), 0).x;
    let reprojViewPos  = ssrViewPositionWith(tapUv, reprojDepth, params.prevInvProjection);
    let reprojWorldPos = (params.prevInvView * vec4<f32>(reprojViewPos, 1.0)).xyz;
    let reprojWorldNorm = octahedral01ToNormal(textureLoad(prevNormals, ssrGBufferCoord(prevNormals, tapUv), 0).xy);

    let planeDiff = abs(dot(reprojWorldPos - worldPosition, worldNormal)) / abs(reprojViewPos.z);
    let normalConfidence = smoothstep(0.95, 0.999, dot(reprojWorldNorm, worldNormal));
    let confidence = (1.0 - smoothstep(0.0, 0.01, planeDiff)) * normalConfidence;
    let weight = bilinearWeight * confidence;

    tap.color = color * weight;
    tap.weight = weight;
    tap.confidence = confidence;
    return tap;
}

struct HistoryResult {
    color:         vec4<f32>,
    tapConfidence: f32,
    minConfidence: f32,
}

fn sampleHistory4Tap(reprojUV: vec2<f32>, dims: vec2<i32>, worldPosition: vec3<f32>,
                     worldNormal: vec3<f32>, inputColor: vec3<f32>) -> HistoryResult {
    let p  = reprojUV * vec2<f32>(dims) - 0.5;
    let ic = vec2<i32>(floor(p));
    let f  = fract(p);

    let t00 = sampleBilinearTap(ic,                    (1.0 - f.x) * (1.0 - f.y), dims, worldPosition, worldNormal);
    let t10 = sampleBilinearTap(ic + vec2<i32>(1, 0),  f.x * (1.0 - f.y),         dims, worldPosition, worldNormal);
    let t01 = sampleBilinearTap(ic + vec2<i32>(0, 1),  (1.0 - f.x) * f.y,         dims, worldPosition, worldNormal);
    let t11 = sampleBilinearTap(ic + vec2<i32>(1, 1),  f.x * f.y,                 dims, worldPosition, worldNormal);

    let colorSum  = t00.color + t10.color + t01.color + t11.color;
    let weightSum = t00.weight + t10.weight + t01.weight + t11.weight;

    var r: HistoryResult;
    r.color = select(vec4<f32>(inputColor, 1.0), colorSum / weightSum, weightSum > 0.01);
    r.tapConfidence = max(max(t00.confidence, t10.confidence), max(t01.confidence, t11.confidence));
    r.minConfidence = min(min(t00.confidence, t10.confidence), min(t01.confidence, t11.confidence));
    return r;
}

// Minimum singular value of the reprojection Jacobian (history magnification detector),
// from forward differences of the history UV.
fn reprojectionStretchConfidence(historyUV: vec2<f32>, historyUVx: vec2<f32>, historyUVy: vec2<f32>,
                                 resolution: vec2<f32>) -> f32 {
    let jx = (historyUVx - historyUV) * resolution;
    let jy = (historyUVy - historyUV) * resolution;
    let det  = jx.x * jy.y - jx.y * jy.x;
    let fro2 = dot(jx, jx) + dot(jy, jy);
    let disc = sqrt(max(fro2 * fro2 * 0.25 - det * det, 0.0));
    let sigMin = sqrt(max(fro2 * 0.5 - disc, 0.0));
    return clamp(sigMin, 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims   = vec2<i32>(textureDimensions(outputAccum));
    let texel  = vec2<i32>(gid.xy);
    if (texel.x >= dims.x || texel.y >= dims.y) { return; }

    let resolution = vec2<f32>(dims);
    let uv = (vec2<f32>(texel) + 0.5) / resolution;

    let depth = ssrSampleDepth(uv);
    if (depth >= 1.0 || depth <= 0.0001) {
        textureStore(outputAccum, texel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
        return;
    }

    let inputColor = max(textureLoad(ssrRaw, texel, 0), vec4<f32>(0.0));

    // First frame / after resize: seed the history with the current frame.
    if (params.historyValid < 0.5) {
        textureStore(outputAccum, texel, vec4<f32>(inputColor.rgb, 1.0));
        return;
    }

    let neighborhood  = collectNeighborhood(texel, inputColor, dims);
    let worldNormal   = worldNormalAt(uv);
    let worldPosition = worldPositionAt(uv);

    // ── Surface reprojection (camera motion) ─────────────────────────────────
    let historyUV  = ssrProjectToPrevUV(worldPosition);
    let historyUVx = ssrProjectToPrevUV(worldPositionAt(uv + vec2<f32>(1.0 / resolution.x, 0.0)));
    let historyUVy = ssrProjectToPrevUV(worldPositionAt(uv + vec2<f32>(0.0, 1.0 / resolution.y)));
    let velocityOff  = uv - historyUV;
    let motionFactor = clamp(length(velocityOff * resolution) / MAX_VELOCITY_LENGTH, 0.0, 1.0);

    let surf = sampleHistory4Tap(historyUV, dims, worldPosition, worldNormal, inputColor.rgb);

    // ── Specular resolve: blend surface and hit-point reprojections ─────────
    let surfValid = ssrUvInside(historyUV);
    let cameraRay = normalize(worldPosition - camera.cameraPosition.xyz);
    let historyUVHit = ssrProjectToPrevUV(worldPosition + cameraRay * neighborhood.rayLength);
    let hitValid = ssrUvInside(historyUVHit) && params.hitPointReprojection > 0.5;
    let hit = sampleHistory4Tap(historyUVHit, dims, worldPosition, worldNormal, inputColor.rgb);

    let hcHit  = max(hit.color.rgb, vec3<f32>(0.0));
    let hcSurf = max(surf.color.rgb, vec3<f32>(0.0));
    let confHit  = select(0.0, hit.tapConfidence, hitValid);
    let confSurf = select(0.0, surf.tapConfidence, surfValid);

    let reflectionEdgeFactor = 1.0 - min(neighborhood.stdDevRayLength * min(motionFactor * 100.0, 1.0) * 3.5, 1.0);
    let nX = worldNormalAt(uv + vec2<f32>(1.0 / resolution.x, 0.0));
    let nY = worldNormalAt(uv + vec2<f32>(0.0, 1.0 / resolution.y));
    let curvatureFactor = clamp(length(abs(nX - worldNormal) + abs(nY - worldNormal)) * 50.0, 0.0, 1.0);

    let wHitRaw = hit.minConfidence * reflectionEdgeFactor * (1.0 - curvatureFactor) * confHit;
    let wHit  = wHitRaw * (1.0 - neighborhood.envProbability * neighborhood.envProbability);
    let wSurf = (1.0 - wHit) * confSurf;
    let wSum  = max(wHit + wSurf, EPSILON);

    var historyColor = vec4<f32>((hcHit * wHit + hcSurf * wSurf) / wSum, surf.color.a);
    var totalConfidence = (confHit * wHit + confSurf * wSurf) / wSum;
    let historyTrust = wHitRaw;
    if (length(historyColor.rgb) < EPSILON) {
        historyColor = vec4<f32>(inputColor.rgb, 1.0);
    }

    // ── Variance clipping + confidences ──────────────────────────────────────
    let a = max(historyColor.a, EPSILON);
    let stretchConfidence = reprojectionStretchConfidence(historyUV, historyUVx, historyUVy, resolution);
    totalConfidence *= stretchConfidence * stretchConfidence;

    let varianceGamma = mix(VARIANCE_GAMMA_MIN, VARIANCE_GAMMA_MAX, (1.0 - motionFactor) * (1.0 - motionFactor));
    let stddev = neighborhood.stdColor * varianceGamma;
    let historyScale = ssrLuminance(historyColor.rgb) * params.flickerSuppression * VARIANCE_CLIP_LUMA_SCALE + 1.0;
    let clipped = clipToAABB(rgbToYCoCg(historyColor.rgb / historyScale),
                             neighborhood.mean - stddev, neighborhood.mean + stddev);
    let clippedRGB = ycocgToRGB(clipped) * historyScale;

    let clampIntensity = params.clampIntensity * max(min(motionFactor * 10.0, 1.0), 0.25)
                       * (1.0 + clamp((1.0 - stretchConfidence) + (1.0 - historyTrust), 0.0, 1.0));
    let originalHistory = historyColor.rgb;
    historyColor = vec4<f32>(mix(historyColor.rgb, clippedRGB, clampIntensity), historyColor.a);
    totalConfidence *= exp(-length(originalHistory - clippedRGB) * clampIntensity * 30.0);
    totalConfidence *= mix(1.0, historyTrust * 0.05 + 0.95, clamp(motionFactor * 100.0, 0.0, 1.0));

    if (totalConfidence < EPSILON) {
        historyColor = vec4<f32>(inputColor.rgb, 1.0);
    }

    var frameCount = min(1.0 / a * totalConfidence + 1.0, params.maxFrames);
    if (length(inputColor.rgb) < EPSILON) {
        frameCount = max(frameCount - 1.0, 1.0);
    }
    textureStore(outputAccum, texel, vec4<f32>(historyColor.rgb, 1.0 / frameCount));
}
