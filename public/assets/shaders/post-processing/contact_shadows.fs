#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

// ─── Contact Shadow Parameters ───────────────────────────────────────────────
// Struct matches TypeScript side: 8 floats = 32 bytes
// lightDir (vec3) + intensity (f32) = first 16 bytes (vec3 padded to 16 via WGSL rules)
// stepLength + maxDistance + thickness + enabled = last 16 bytes
struct ContactShadowParams {
    lightDir:    vec3<f32>,  // world-space direction FROM surface TOWARD light
    intensity:   f32,        // shadow strength [0, 1]
    stepLength:  f32,        // world-space ray step size (meters)
    maxDistance: f32,        // max ray travel distance (meters)
    thickness:   f32,        // linearDepth tolerance for occlusion detection
    enabled:     f32,        // 0 = disabled
}

// ─── Bind Groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// GBuffer — standard layout (group 1)
@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// Contact shadow params (group 2) — outputs shadow factor [0,1], not accLight
@group(2) @binding(0) var<uniform> params: ContactShadowParams;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Project a world-space position to screen UV [0,1].
// Returns vec3: xy = UV, z = clip.w (≤ 0 means behind camera — treat as invalid).
fn worldToUVW(worldPos: vec3<f32>) -> vec3<f32> {
    let clip = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(worldPos, 1.0));
    // Guard: behind camera → return sentinel so caller can skip this step
    if (clip.w <= 0.0) {
        return vec3<f32>(0.0, 0.0, -1.0);
    }
    let ndc = clip.xy / clip.w;
    // WebGPU NDC: x∈[-1,1]→[0,1], y∈[-1,1] (Y-up)→[1,0] (Y-down in UV)
    return vec3<f32>(ndc.x * 0.5 + 0.5, -ndc.y * 0.5 + 0.5, clip.w);
}

// Compute the linearDepth convention used by the GBuffer for an arbitrary world pos.
// GBuffer stores: dot(worldPos - cameraPos, cameraFront) / zFar
fn worldToLinearDepth(pos: vec3<f32>) -> f32 {
    let diff = pos - camera.cameraPosition.xyz;
    return dot(diff, camera.cameraFront.xyz) / camera.cameraFar;
}

// Interleaved Gradient Noise — low-discrepancy per-pixel noise in [0, 1).
// Breaks up banding from fixed-step ray marching without repeating tile patterns.
fn interleavedGradientNoise(coord: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(coord, vec2<f32>(0.06711056, 0.00583715))));
}

// ─── Fragment Entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / camera.screenSize;

    // Early-out: disabled — factor 1.0 means no attenuation
    if (params.enabled < 0.5) {
        return vec4<f32>(1.0);
    }

    // Decode GBuffer — gives worldPos, normal, zlinear, etc.
    let g = decodeGBuffer(uv);

    // Early-out: sky / far plane
    if (g.zlinear >= 0.9999) {
        return vec4<f32>(1.0);
    }

    // Early-out: surface facing away from the light (backlit → no contact shadow)
    let NdL = saturate(dot(g.normal, params.lightDir));
    if (NdL < 0.01) {
        return vec4<f32>(1.0);
    }

    // ── Screen-space-aware step count ────────────────────────────────────────
    // World-space steps produce banding near the camera because a fixed step
    // covers very different numbers of pixels depending on depth.  Project the
    // full ray extent to screen space and derive numSteps so each step covers
    // roughly a constant number of pixels — dense near the camera, sparse far.
    var numSteps: i32 = 16; // safe fallback
    let startClip = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(g.worldPos, 1.0));
    let endWorld  = g.worldPos + params.lightDir * params.maxDistance;
    let endClip   = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(endWorld, 1.0));
    if (startClip.w > 0.0 && endClip.w > 0.0) {
        let startNDC  = startClip.xy / startClip.w;
        let endNDC    = endClip.xy   / endClip.w;
        // Convert NDC distance to pixels (account for UV-space scale)
        let startUV   = vec2<f32>(startNDC.x * 0.5 + 0.5, -startNDC.y * 0.5 + 0.5);
        let endUV     = vec2<f32>(endNDC.x   * 0.5 + 0.5, -endNDC.y   * 0.5 + 0.5);
        let screenPx  = length((endUV - startUV) * camera.screenSize);
        // ~1 step every 3 pixels, clamped to a sensible range
        numSteps = clamp(i32(screenPx / 3.0), 4, 32);
    }

    // ── Adaptive step size derived from maxDistance ──────────────────────────
    // Using a fixed params.stepLength against a dynamic numSteps means the ray
    // covers numSteps * stepLength which may be far less than maxDistance (deficit)
    // or exceed it (handled by the old t > maxDistance guard, but the near-camera
    // deficit case was silently under-sampling the shadow region).
    // Deriving actualStep from maxDistance guarantees the ray always spans exactly
    // [0, maxDistance] regardless of how many steps the screen-space heuristic chose.
    let actualStep = params.maxDistance / f32(numSteps);

    // ── Self-shadowing bias ───────────────────────────────────────────────────
    // Per-pixel jitter (IGN + golden-ratio temporal shift) randomises the starting
    // offset of each ray so adjacent pixels and adjacent frames never share the same
    // discrete sample pattern.  Breaks banding stripes and lets TAA accumulate a
    // clean result over multiple frames.
    let jitter = fract(interleavedGradientNoise(fragCoord.xy) + camera.frameIndex * 0.6180339887);
    // Offset the first sample into [0, actualStep) so the ray starts slightly ahead
    // of the surface.  The depth-proportional term prevents acne at large view depths.
    let startBias = actualStep * jitter + g.zlinear * camera.cameraFar * 0.001;

    // ── World-space ray march toward light ───────────────────────────────────
    var shadow: f32 = 0.0;

    for (var i: i32 = 1; i <= numSteps; i++) {
        let t = startBias + f32(i) * actualStep;
        // t is bounded by startBias + numSteps * actualStep = jitter*actualStep + maxDistance
        // which is at most maxDistance + actualStep — no break needed.

        let rayPos = g.worldPos + params.lightDir * t;
        let uvw    = worldToUVW(rayPos);

        // Behind camera: skip this step, continue ray (don't abort entirely)
        if (uvw.z <= 0.0) { continue; }

        let rayUV = uvw.xy;

        // Outside screen: continue — the ray may re-enter near screen edges
        if (rayUV.x < 0.0 || rayUV.x > 1.0 || rayUV.y < 0.0 || rayUV.y > 1.0) {
            continue;
        }

        let sceneZ = textureSampleLevel(gLinearDepth, samplerGBuffer, rayUV, 0.0).x;
        let rayZ   = worldToLinearDepth(rayPos);

        // Ray is behind geometry and within the thickness band → occluded
        let delta = rayZ - sceneZ;
        if (delta > 0.0 && delta < params.thickness) {
            let fade = 1.0 - t / params.maxDistance;
            // Contact shadow is binary (occluder present or not) — do NOT scale by
            // NdL here.  Grazing surfaces (low NdL) can still be fully occluded;
            // surfaces facing away are already excluded by the early-out above.
            shadow = params.intensity * max(0.0, fade);
            break;
        }
    }

    // Output shadow factor: 1.0 = fully lit, 0.0 = fully in shadow
    let shadowFactor = 1.0 - shadow;
    return vec4<f32>(shadowFactor, shadowFactor, shadowFactor, 1.0);
}

