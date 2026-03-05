// Screen-Space Reflections — compute shader
// Replaces the fullscreen-quad + fragment-shader approach (ssr.fs) with a direct
// compute dispatch, eliminating quad rasterization overhead.
//
// Optimizations:
//   • Screen-space DDA march — endpoints projected once, zero matrix muls per step.
//   • Back-face cull — rays pointing away from camera skipped before march.
//   • Screen-edge cull — negligible delta UV means no visible hit possible.
//   • Cheap depth early exit — sky/background skipped before decoding GBuffer.
//   • Aggressive surface cull — metallic, roughness, specularWeight thresholds.
//   • Adaptive binary refinement — 8 steps for sharp, 4 for rough surfaces.
//   • Mip-level accLight sampling — cheaper fetch + correct soft look.
//
// Bind-group layout:
//   group(0)  Camera uniforms       (CameraUniforms UBO)
//   group(1)  G-Buffer              (albedo, normals, linearDepth, sampler)
//   group(2)  SSR params + inputs   (accLight, ao, brdfLUT, sampler, SSRUniforms UBO)
//   group(3)  Output storage tex    (rgba16float write-only)

// common/pbr/core is intentionally omitted: common/gbuffer already pulls in
// common/core/constants transitively, so re-including pbr/core causes WGSL
// redeclaration errors for PI, TWO_PI, saturate, etc.
#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

// Fresnel_Schlick_Roughness inlined — avoids pulling common/pbr/core.
fn SSR_Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let r1 = max(vec3<f32>(1.0 - roughness), F0);
    return F0 + (r1 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// ── Group 0: camera ───────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ── Group 1: G-Buffer ─────────────────────────────────────────────────────────
@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// ── Group 2: SSR params ───────────────────────────────────────────────────────
@group(2) @binding(0) var accLight:           texture_2d<f32>;
@group(2) @binding(1) var aoTexture:          texture_2d<f32>;
@group(2) @binding(2) var brdfLUT:            texture_2d<f32>;
@group(2) @binding(3) var texSampler:         sampler;
@group(2) @binding(4) var<uniform> ssrParams: SSRUniforms;

// ── Group 3: output ───────────────────────────────────────────────────────────
@group(3) @binding(0) var outputSSR: texture_storage_2d<rgba16float, write>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Projects a world-space position to screen UV only (no depth).
/// Used once per ray to compute the screen-space end point.
fn projectWorldToUV(worldPos: vec3<f32>) -> vec2<f32> {
    let viewPos = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let clipPos = camera.projectionMatrix * viewPos;
    let ndc     = clipPos.xy / clipPos.w;
    var uv      = ndc * 0.5 + 0.5;
    uv.y        = 1.0 - uv.y;
    return uv;
}

/// Camera-front linear depth of a world position: dot(P-camPos, camFront) / camFar
fn worldToLinearDepth(worldPos: vec3<f32>) -> f32 {
    return dot(worldPos - camera.cameraPosition.xyz, camera.cameraFront.xyz) / camera.cameraFar;
}

fn calcEdgeFade(uv: vec2<f32>) -> f32 {
    let fw = 0.1;
    let fx = min(uv.x / fw, (1.0 - uv.x) / fw);
    let fy = min(uv.y / fw, (1.0 - uv.y) / fw);
    return clamp(min(fx, fy), 0.0, 1.0);
}

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N     = normalize(g.normal);
    let V     = normalize(g.viewDir);
    let NdotV = max(dot(N, V), 0.0);
    let F0    = g.specularColor;
    let F     = SSR_Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(
        clamp(g.roughness,  0.0, 1.0),
        clamp(1.0 - NdotV, 0.0, 1.0),
    );
    let brdf = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    return color * (F * brdf.x + brdf.y);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen-space DDA ray march + adaptive binary refinement
// ─────────────────────────────────────────────────────────────────────────────
fn marchScreenSpace(
    startWorldPos: vec3<f32>,
    rayDir:        vec3<f32>,
    startDepth:    f32,
    startUV:       vec2<f32>,
    roughness:     f32,
) -> vec4<f32> {
    let maxDistance = ssrParams.maxDistance;
    let maxSteps    = i32(ssrParams.maxSteps);

    // ── Back-face cull ────────────────────────────────────────────────────────
    // Ray pointing away from the camera (view-Z >= 0) can never produce a hit.
    let rayViewZ = (camera.viewMatrix * vec4<f32>(rayDir, 0.0)).z;
    if (rayViewZ >= 0.0) { return vec4<f32>(0.0); }

    // Project start and end of the ray into screen UV (two matrix muls, done once)
    let endWorldPos = startWorldPos + rayDir * maxDistance;
    let endUV       = projectWorldToUV(endWorldPos);
    let endRayDepth = worldToLinearDepth(endWorldPos);

    let deltaUV    = endUV - startUV;
    let deltaDepth = endRayDepth - startDepth;

    // ── Screen-edge cull ──────────────────────────────────────────────────────
    // Skip rays that cover less than 1 texel — nothing useful to find.
    let dims2f      = vec2<f32>(textureDimensions(outputSSR));
    let deltaPixels = abs(deltaUV) * dims2f;
    if (max(deltaPixels.x, deltaPixels.y) < 1.0) { return vec4<f32>(0.0); }

    let invSteps = 1.0 / f32(maxSteps);

    // Mip level for accLight — rougher surfaces sample a blurrier mip (max 4)
    let hitMip = roughness * 4.0;

    var prevUV    = startUV;
    var prevDepth = startDepth;

    for (var i = 1; i <= maxSteps; i++) {
        let t        = f32(i) * invSteps;
        let curUV    = startUV + deltaUV * t;
        let curDepth = startDepth + deltaDepth * t;

        // Off-screen exit
        if (any(curUV < vec2<f32>(0.0)) || any(curUV > vec2<f32>(1.0))) { break; }

        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, curUV, 0.0).r;

        if (curDepth > sampledDepth
            && (curDepth - sampledDepth) < ssrParams.thickness
            && sampledDepth > startDepth)
        {
            // ── Adaptive binary refinement ────────────────────────────────────
            // Sharp surfaces (roughness < 0.35) get 8 bisection steps.
            // Rougher surfaces only need 4 — result is blurred anyway.
            let refineSteps = select(4u, 8u, roughness < 0.35);

            var lo     = prevUV;
            var loD    = prevDepth;
            var hi     = curUV;
            var hiD    = curDepth;
            var bestUV = curUV;

            for (var r = 0u; r < refineSteps; r++) {
                let midUV      = (lo + hi) * 0.5;
                let midD       = (loD + hiD) * 0.5;
                let midSampled = textureSampleLevel(gLinearDepth, samplerGBuffer, midUV, 0.0).r;
                if (midD > midSampled) {
                    hi     = midUV;
                    hiD    = midD;
                    bestUV = midUV;
                } else {
                    lo  = midUV;
                    loD = midD;
                }
            }

            let hitColor = textureSampleLevel(accLight, texSampler, bestUV, hitMip);
            let distFade = 1.0 - t;
            let edgeFade = calcEdgeFade(bestUV);
            let fade     = clamp(distFade * edgeFade, 0.0, 1.0);
            return vec4<f32>(hitColor.rgb, fade);
        }

        prevUV    = curUV;
        prevDepth = curDepth;
    }

    return vec4<f32>(0.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main compute entry — workgroup 8×8, one thread per output pixel
// ─────────────────────────────────────────────────────────────────────────────
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims   = vec2<i32>(textureDimensions(outputSSR));
    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dims.x || coords.y >= dims.y) { return; }

    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dims);

    // Cheap sky / disabled early exit — sample depth before decoding the full GBuffer
    let rawDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).r;
    if (ssrParams.enabled < 0.5 || rawDepth >= 0.9999) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    let g = decodeGBuffer(uv);

    // Non-reflective surface early exit — three layered checks, cheapest first:
    //   1. metallic < 0.2 → mostly diffuse, F0 ≈ 0.04, reflections invisible
    //   2. roughness > 0.7 → surface too rough, result would be fully blurred
    //   3. combined specular weight — catches mid-range cases where both metallic
    //      and roughness together make the contribution imperceptible
    let baseReflectance = mix(0.04, 1.0, g.metallic);
    let specularWeight  = baseReflectance * (1.0 - g.roughness * g.roughness);
    if (g.metallic < 0.2 || g.roughness > 0.7 || specularWeight < 0.08) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    let result       = marchScreenSpace(g.worldPos, g.reflectedDir, g.zlinear, uv, g.roughness);
    let contribution = applyFresnelBRDF(result.rgb, g);
    textureStore(outputSSR, coords, vec4<f32>(contribution, result.a));
}
