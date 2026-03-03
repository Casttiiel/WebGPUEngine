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

// Project a world-space position to screen UV [0,1]
fn worldToUV(worldPos: vec3<f32>) -> vec2<f32> {
    let clip = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(worldPos, 1.0));
    let ndc  = clip.xy / clip.w;
    // WebGPU NDC: x∈[-1,1]→[0,1], y∈[-1,1] (Y-up)→[1,0] (Y-down in UV)
    return vec2<f32>(ndc.x * 0.5 + 0.5, -ndc.y * 0.5 + 0.5);
}

// Compute the linearDepth convention used by the GBuffer for an arbitrary world pos.
// GBuffer stores: dot(worldPos - cameraPos, cameraFront) / zFar
fn worldToLinearDepth(pos: vec3<f32>) -> f32 {
    let diff = pos - camera.cameraPosition.xyz;
    return dot(diff, camera.cameraFront.xyz) / camera.cameraFar;
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

    // Early-out: surface facing away from the light (backlit surfaces don't cast contact shadows)
    let NdL = saturate(dot(g.normal, params.lightDir));
    if (NdL <= 0.0) {
        return vec4<f32>(1.0);
    }

    // ── Screen-space ray march toward light ──────────────────────────────────
    var shadow: f32 = 0.0;

    // Compute number of steps to cover maxDistance
    let numSteps: i32 = clamp(i32(params.maxDistance / params.stepLength), 1, 24);

    for (var i: i32 = 1; i <= numSteps; i++) {
        let t        = f32(i) * params.stepLength;
        let rayPos   = g.worldPos + params.lightDir * t;

        let rayUV    = worldToUV(rayPos);

        // Discard steps outside the screen
        if (rayUV.x < 0.0 || rayUV.x > 1.0 || rayUV.y < 0.0 || rayUV.y > 1.0) {
            break;
        }

        let sceneZ = textureSampleLevel(gLinearDepth, samplerGBuffer, rayUV, 0.0).x;
        let rayZ   = worldToLinearDepth(rayPos);

        // Ray is behind geometry (further from camera) and within the thickness band?
        let delta = rayZ - sceneZ;
        if (delta > 0.0 && delta < params.thickness) {
            // Fade with distance; scale by NdL so shadow only affects where DL actually contributes
            let fade = 1.0 - t / params.maxDistance;
            shadow   = params.intensity * max(0.0, fade) * NdL;
            break;
        }
    }

    // Output shadow factor: 1.0 = fully lit, 0.0 = fully in shadow
    let shadowFactor = 1.0 - shadow;
    return vec4<f32>(shadowFactor, shadowFactor, shadowFactor, 1.0);
}
