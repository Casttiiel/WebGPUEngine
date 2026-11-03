// ---------------------------------------------------------------------------
// SSR recurrent denoise — compute shader
// Port of three.js RecurrentDenoiseNode (mode 'specular', alphaSource 'raylength',
// accumulate: true), algorithms originally from NVIDIA REBLUR (NRD):
//   • 8-tap Vogel disk in the specular-lobe plane, rotated per pixel (R4 noise)
//   • radius ∝ ray length · view depth · √roughness, shrunk with history confidence
//   • edge stopping: luma, hit distance, roughness, plane distance, lobe-adaptive normals
//   • adaptive radius shrink + polar bias toward high-weight directions
//   • Karis inverse-luminance temporal blend of the denoised history with the denoised
//     raw frame (adaptive trust), frame count smoothed across disocclusions
//
// Inputs: reprojected history (ssr_temporal.cs: rgb, a = 1/frames) and raw SSR (rgb, a = ray length).
// Output (rgba16float): rgb = denoised reflection radiance, a = 1 / frames.
// This output is next frame's history (temporal reprojection + SSR multi-bounce).
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/octahedral"
#include "post-processing/ssr_common"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var reprojected:     texture_2d<f32>;
@group(2) @binding(1) var<uniform> params: SSRTraceParams;
@group(2) @binding(2) var ssrRaw:          texture_2d<f32>;
@group(2) @binding(3) var linearSampler:   sampler;

@group(3) @binding(0) var outputDenoised: texture_storage_2d<rgba16float, write>;

const EPSILON: f32 = 1e-5;
const KERNEL_SAMPLES: i32 = 8;
const NOISE_ROTATION_SEED: f32 = 83.0;
const WORLD_RADIUS_SCALE: f32 = 0.1;
const AGGRESSIVITY_RADIUS_MIN: f32 = 0.001;
const FLICKER_COV_GATE_MIN: f32 = 0.1;
const FLICKER_COV_GATE_MAX: f32 = 2.0;
const EXP_WEIGHT_SCALE: f32 = 4.0;
const NORMAL_ENCODING_ERROR: f32 = 1.5 / 255.0;

// ── G-buffer access (nearest) ────────────────────────────────────────────────
struct Surface {
    viewPosition: vec3<f32>,
    viewNormal:   vec3<f32>,
    worldNormal:  vec3<f32>,
    roughness:    f32,
}

fn surfaceAt(uv: vec2<f32>) -> Surface {
    var s: Surface;
    let nData = textureLoad(gNormals, ssrGBufferCoord(gNormals, uv), 0);
    s.worldNormal  = octahedral01ToNormal(nData.xy);
    s.viewNormal   = normalize((camera.viewMatrix * vec4<f32>(s.worldNormal, 0.0)).xyz);
    s.roughness    = max(nData.z, 0.045);
    s.viewPosition = ssrViewPosition(uv, ssrSampleDepth(uv));
    return s;
}

fn sampleReprojected(uv: vec2<f32>) -> vec4<f32> {
    return max(textureSampleLevel(reprojected, linearSampler, uv, 0.0), vec4<f32>(0.0));
}

fn sampleRaw(uv: vec2<f32>) -> vec4<f32> {
    return max(textureSampleLevel(ssrRaw, linearSampler, uv, 0.0), vec4<f32>(0.0));
}

// ── REBLUR helpers ───────────────────────────────────────────────────────────
fn vogelDisk(i: f32, radius: f32) -> vec2<f32> {
    let theta = (i + 0.5) * 2.399827721492203;
    let r = radius * sqrt((i + 0.5) / f32(KERNEL_SAMPLES));
    return vec2<f32>(cos(theta), sin(theta)) * r;
}

fn getTemporalVarianceFactor(frameNum: f32, strength: f32) -> f32 {
    return max(1.0 / pow(frameNum, strength), 0.05);
}

// World ray length → [0,1] relative to the frustum size at this depth.
fn computeHitDistFactor(worldRayLength: f32, viewZ: f32, tanHalfFovY: f32) -> f32 {
    let frustumSize = 2.0 * viewZ * tanHalfFovY;
    return clamp(worldRayLength / max(frustumSize, 1e-6), 0.0, 1.0);
}

fn getSpecularDominantDirection(N: vec3<f32>, V: vec3<f32>, roughness: f32) -> vec3<f32> {
    return normalize(mix(N, reflect(-V, N), 1.0 - roughness));
}

fn lobeNormalFalloff(roughness: f32, aggressivity: f32, invNormalPhi: f32) -> f32 {
    let percent = clamp(mix(invNormalPhi * invNormalPhi, 0.0, sqrt(aggressivity)), 0.1, 0.99);
    let alpha = roughness * roughness;
    let tanHalfAngle  = alpha * sqrt(percent / max(1.0 - percent, 1e-6));
    let lobeHalfAngle = max(atan(tanHalfAngle), NORMAL_ENCODING_ERROR);
    let invHalfAngle  = 1.0 / lobeHalfAngle;
    return invHalfAngle * invHalfAngle * (2.0 * EXP_WEIGHT_SCALE);
}

// Inverse-luminance temporal blend with adaptive trust (Karis-style).
fn karisTemporalBlend(denoisedRgb: vec3<f32>, denoisedRaw: vec3<f32>, a: f32,
                      nbhdMeanLuma: f32, nbhdStddevLuma: f32) -> vec3<f32> {
    let localCoV = nbhdStddevLuma / max(nbhdMeanLuma, 1e-4);
    let trustSuppress = clamp(localCoV * params.adaptiveTrust * (1.0 - a), 0.0, 0.9);
    let aTrust = a * (1.0 - trustSuppress);
    // In flicker-free neighbourhoods back off the inverse-luminance weighting so valid
    // bright highlights keep their energy.
    let noisy = smoothstep(FLICKER_COV_GATE_MIN, FLICKER_COV_GATE_MAX, localCoV);
    let effFlicker = params.flickerSuppression * mix(1.0 - params.adaptiveTrust, 1.0, noisy);
    let wHist = (1.0 - aTrust) / (ssrLuminance(denoisedRgb) * effFlicker * 10.0 + 1.0);
    let wRaw  = aTrust / (ssrLuminance(denoisedRaw) * effFlicker * 10.0 + 1.0);
    return (denoisedRgb * wHist + denoisedRaw * wRaw) / max(wHist + wRaw, EPSILON);
}

// 4-tap cross over the raw SSR: hit-distance-weighted ray length + luma moments.
struct NeighborhoodStats {
    rayLength:  f32,
    meanLuma:   f32,
    stddevLuma: f32,
    hasEnvRay:  bool,
}

fn getNeighborhoodStats(uv: vec2<f32>, centerSample: vec4<f32>, resolution: vec2<f32>) -> NeighborhoodStats {
    var rlSum = 0.0;
    var rlSumW = 0.0;
    var meanLuma = 0.0;
    var m2Luma = 0.0;
    var lumaCount = 0.0;
    var hasEnvRay = false;

    for (var k = 0; k < 5; k++) {
        var neighbor = centerSample;
        if (k > 0) {
            let o = array<vec2<f32>, 4>(vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0),
                                        vec2<f32>(0.0, -1.0), vec2<f32>(0.0, 1.0));
            neighbor = sampleRaw(uv + o[k - 1] / resolution);
        }
        var sampleRl = neighbor.a;
        if (sampleRl > ENV_RAY_LENGTH_THRESHOLD) {
            sampleRl = 0.25;
            hasEnvRay = true;
        }
        let w = 1.0 / (sampleRl + 0.001);
        rlSum  += sampleRl * w;
        rlSumW += w;

        if (params.adaptiveTrust > 0.0) {
            let nLuma = ssrLuminance(neighbor.rgb);
            lumaCount += 1.0;
            let delta = nLuma - meanLuma;
            meanLuma += delta / lumaCount;
            m2Luma   += delta * (nLuma - meanLuma);
        }
    }

    var s: NeighborhoodStats;
    s.rayLength  = rlSum / rlSumW;
    s.meanLuma   = meanLuma;
    s.stddevLuma = sqrt(m2Luma / max(lumaCount, 1.0));
    s.hasEnvRay  = hasEnvRay;
    return s;
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims  = vec2<i32>(textureDimensions(outputDenoised));
    let texel = vec2<i32>(gid.xy);
    if (texel.x >= dims.x || texel.y >= dims.y) { return; }

    let resolution = vec2<f32>(dims);
    let uv = (vec2<f32>(texel) + 0.5) / resolution;

    let depth = ssrSampleDepth(uv);
    if (depth >= 1.0 || depth <= 0.0001) {
        textureStore(outputDenoised, texel, vec4<f32>(0.0, 0.0, 0.0, 1.0));
        return;
    }

    let center = surfaceAt(uv);
    let viewPosition = center.viewPosition;
    let viewNormal   = center.viewNormal;
    let roughness    = center.roughness;

    let texelColor = textureLoad(reprojected, texel, 0);
    let raw        = max(textureLoad(ssrRaw, texel, 0), vec4<f32>(0.0));

    // Per-pixel kernel rotation
    let noise = ssrAnalyticNoise(uv * resolution, i32(params.noiseIndex), NOISE_ROTATION_SEED);
    let angle = noise.r * 2.0 * PI_SSR;
    let rotation = mat2x2<f32>(cos(angle), -sin(angle), sin(angle), cos(angle));

    let frameNum = 1.0 / max(texelColor.a, EPSILON);
    let varianceFactor = getTemporalVarianceFactor(frameNum, 1.0 - params.strength);
    let aggressivity = 1.0 - varianceFactor;

    let viewZ = abs(viewPosition.z);
    let stats = getNeighborhoodStats(uv, raw, resolution);
    let rl = stats.rayLength;
    // tan(fovY / 2) from the projection matrix
    let tanHalfFovY = 1.0 / camera.projectionMatrix[1][1];
    let hitDistFactor = computeHitDistFactor(rl, viewZ, tanHalfFovY);

    var denoised = texelColor.rgb;
    var totalWeight = 1.0;
    var denoisedFrame = frameNum;
    var totalFrameWeight = 1.0;
    var denoisedRaw = raw.rgb;
    var totalWeightRaw = 1.0;
    if (length(raw.rgb) < 0.0001) {
        denoisedRaw = vec3<f32>(0.0);
        totalWeightRaw = 0.0;
    }

    // ── Kernel basis in the specular lobe plane ──────────────────────────────
    var worldRadius = params.denoiseRadius * WORLD_RADIUS_SCALE;
    worldRadius *= rl * viewZ;
    worldRadius *= max(sqrt(roughness), 0.01);
    worldRadius *= mix(1.0, AGGRESSIVITY_RADIUS_MIN, aggressivity);

    let V = -normalize(viewPosition);
    let D = getSpecularDominantDirection(viewNormal, V, roughness);
    let R = reflect(-D, viewNormal);
    var Tv = cross(viewNormal, R);
    if (length(Tv) < 1e-5) { // R ∥ N (view along the normal): any tangent works
        Tv = cross(select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(viewNormal.y) > 0.9), viewNormal);
    }
    Tv = normalize(Tv);
    let Bv = cross(R, Tv);
    let viewAngle  = clamp(acos(abs(viewNormal.z)) / (PI_SSR * 0.5), 0.0, 1.0);
    let skewFactor = mix(1.0, roughness, viewAngle);
    let T = Tv * skewFactor * worldRadius;
    let B = Bv * worldRadius;

    var radiusShrink = 1.0;
    var polarBias = vec2<f32>(0.0);
    let depthWeightScale = params.depthPhi * 500.0 * abs(viewNormal.z) / viewZ;
    let lobeFalloff = lobeNormalFalloff(roughness, aggressivity, 1.0 - params.normalPhi);

    for (var i = 0; i < KERNEL_SAMPLES; i++) {
        let baseOffset = vogelDisk(f32(i), 1.0);
        let sampleDir  = normalize(baseOffset);
        // Blend the tap direction toward the polar bias, then restore radius and shrink
        let biasOn = select(0.0, 1.0, dot(polarBias, polarBias) > 0.001);
        let skewedDir = mix(sampleDir, normalize(max(polarBias, vec2<f32>(EPSILON))),
                            params.adapt * aggressivity * biasOn);
        let offset = rotation * (skewedDir * (length(baseOffset) * radiusShrink));

        // Exact view-space projection of the tap; mirror at the screen borders
        let sampleViewPos = viewPosition + B * offset.x + T * offset.y;
        var sampleUv = ssrScreenFromClip(camera.projectionMatrix * vec4<f32>(sampleViewPos, 1.0));
        sampleUv = clamp(1.0 - abs(1.0 - abs(sampleUv)), vec2<f32>(0.0), vec2<f32>(1.0));

        let neighborColor    = sampleReprojected(sampleUv);
        let rawNeighborColor = sampleRaw(sampleUv);
        let n = surfaceAt(sampleUv);
        let nViewZ = abs(n.viewPosition.z);

        var kernelDiff = 0.0;
        // Luma edge stopping
        kernelDiff += abs(ssrLuminance(rawNeighborColor.rgb) - ssrLuminance(raw.rgb)) * params.lumaPhi * 10.0;
        // Hit-distance edge stopping (env rays are accepted when the neighbourhood has env rays)
        let neighborHitDistFactor = computeHitDistFactor(rawNeighborColor.a, nViewZ, tanHalfFovY);
        let rayLengthFactor = abs(hitDistFactor - neighborHitDistFactor) * params.alphaPhi / viewZ;
        kernelDiff += select(rayLengthFactor, 1.0,
                             rawNeighborColor.a > ENV_RAY_LENGTH_THRESHOLD && stats.hasEnvRay);
        // Roughness edge stopping
        kernelDiff += abs(roughness - n.roughness) * params.roughnessPhi;

        // Geometric edge stopping (plane distance + lobe-adaptive normal)
        let distToPlane = abs(dot(viewPosition - n.viewPosition, viewNormal));
        let depthDiff = distToPlane * depthWeightScale;
        let normalW = exp((dot(center.worldNormal, n.worldNormal) - 1.0) * lobeFalloff);

        var w = exp(-(kernelDiff * aggressivity + depthDiff)) * normalW;

        // Adaptive radius shrink + polar feedback toward related geometry
        radiusShrink = mix(radiusShrink, w, params.adapt);
        polarBias = mix(polarBias, sampleDir * (w - 0.5), 0.5);

        // Inverse luminance weighting for the first frames (fireflies, fresh disocclusions)
        let rawLuma = ssrLuminance(rawNeighborColor.rgb);
        w *= mix(1.0 / (rawLuma * rawLuma + 0.01), 1.0, min(frameNum / 5.0, 1.0));

        denoisedRaw    += rawNeighborColor.rgb * w;
        totalWeightRaw += w;
        denoised       += neighborColor.rgb * w;
        totalWeight    += w;

        // Smooth the accumulation speed across disocclusion borders
        if (params.smoothDisocclusions > 0.5) {
            let neighborAWeight = select(0.0, w * 0.33, neighborColor.a > texelColor.a);
            denoisedFrame    += (1.0 / max(neighborColor.a, EPSILON)) * neighborAWeight;
            totalFrameWeight += neighborAWeight;
        }
    }

    denoised = max(denoised / max(totalWeight, EPSILON), vec3<f32>(EPSILON));
    denoisedRaw = denoisedRaw / max(totalWeightRaw, EPSILON);

    let computedFrame = denoisedFrame / max(totalFrameWeight, EPSILON);
    let a = 1.0 / max(computedFrame, EPSILON);
    let blended = karisTemporalBlend(denoised, denoisedRaw, a, stats.meanLuma, stats.stddevLuma);

    textureStore(outputDenoised, texel, vec4<f32>(blended, a));
}
