// Screen-Space Reflections — compute shader
// View-space linear march + binary-search refinement.
// Marching in view space gives constant perceived step size at all depths,
// avoiding the large-step artifacts of world-space marching.
// Binary search (8 iters) refines the hit to sub-step accuracy, removing pixelation.
// Thickness scales with distance to suppress false-positive hits on thin objects far away.
//
// Bind-group layout:
//   group(0)  Camera uniforms       (CameraUniforms UBO)
//   group(1)  G-Buffer              (albedo, normals, linearDepth, sampler)
//   group(2)  SSR params + inputs   (accLight, ao, SSRUniforms UBO)
//   group(3)  Output storage tex    (rgba16float write-only)

// common/pbr/core is intentionally omitted: common/gbuffer already pulls in
// common/core/constants transitively, so re-including pbr/core causes WGSL
// redeclaration errors for PI, TWO_PI, saturate, etc.
#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

// ── Group 0: camera ───────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ── Group 1: G-Buffer ─────────────────────────────────────────────────────────
@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// ── Group 2: SSR params ───────────────────────────────────────────────────────
@group(2) @binding(0) var accLight:           texture_2d<f32>;
@group(2) @binding(1) var<uniform> ssrParams: SSRUniforms;

// ── Group 3: output ───────────────────────────────────────────────────────────
@group(3) @binding(0) var outputSSR: texture_storage_2d<rgba16float, write>;

// ─────────────────────────────────────────────────────────────────────────────

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    // 10 % fade bands on all four edges; multiply X×Y for smooth corners.
    let fade = min(uv, vec2<f32>(1.0) - uv) / 0.1;
    return saturate(fade.x) * saturate(fade.y);
}

// ── View-space helper: project a view-space position to screen UV + linear depth ──
// Uses the jittered projectionMatrix but then removes the jitter from the UV so
// that hit lookups into gLinearDepth and accLight address the same texel every
// frame for a perfectly static reflection.  Without this correction the hit UV
// shifts by ±½ pixel each frame → TAA sees it as temporal noise and clamps it away.
//
// Derivation (Y flipped, jitterOffset from Camera.ts = NDC/2):
//   uv_unjit.x = uv_jit.x + jitterOffset.x
//   uv_unjit.y = uv_jit.y - jitterOffset.y
fn viewToScreen(viewPos: vec3<f32>) -> vec3<f32> {
    let clip  = camera.projectionMatrix * vec4<f32>(viewPos, 1.0);
    let ndc   = clip.xyz / clip.w;
    var uv    = ndc.xy * 0.5 + 0.5;
    uv.y      = 1.0 - uv.y;
    // Remove TAA jitter so SSR hit UVs are stable across frames.
    uv.x     += camera.jitterOffset.x;
    uv.y     -= camera.jitterOffset.y;
    let depth = -viewPos.z / camera.cameraFar; // normalised linear depth [0,1]
    return vec3<f32>(uv, depth);
}

// ── Binary search refinement ─────────────────────────────────────────────────
// Bisects between the last miss (loVP) and first hit (hiVP) in view space
// to find the actual surface crossing more precisely (8 iterations = ~1/256 step).
fn binarySearchRefine(loVP: vec3<f32>, hiVP: vec3<f32>) -> vec3<f32> {
    var lo = loVP;
    var hi = hiVP;
    for (var j: i32 = 0; j < 8; j++) {
        let midVP  = (lo + hi) * 0.5;
        let midScr = viewToScreen(midVP);
        if (midScr.x < 0.0 || midScr.x > 1.0 || midScr.y < 0.0 || midScr.y > 1.0) { break; }
        let sceneDep = textureSampleLevel(gLinearDepth, samplerGBuffer, midScr.xy, 0.0).r;
        if (midScr.z > sceneDep) {
            hi = midVP; // mid is inside geometry → move hi back
        } else {
            lo = midVP; // mid is in front → move lo forward
        }
    }
    return hi; // refined hit point (view space)
}

// ── Main ray march (view-space) ───────────────────────────────────────────────
fn performSSRMarch(
    worldPos:   vec3<f32>,
    reflWorld:  vec3<f32>,
    startDepth: f32,
    roughness:  f32,
) -> vec4<f32> {
    let maxSteps    = i32(ssrParams.maxSteps);
    let stepSize    = ssrParams.stepSize;
    let maxDistance = ssrParams.maxDistance;

    // Transform to view space — march here so step size is camera-relative
    let viewStartRaw = (camera.viewMatrix * vec4<f32>(worldPos, 1.0)).xyz;
    let viewDir      = normalize((camera.viewMatrix * vec4<f32>(reflWorld, 0.0)).xyz);

    // Reject rays going toward the camera (behind near plane)
    if (viewDir.z > 0.0) { return vec4<f32>(0.0); }

    // Offset by 2 steps to avoid self-intersection with coplanar geometry
    let viewStart = viewStartRaw + viewDir * stepSize * 2.0;
    var prevVP    = viewStart;
    var currentVP = viewStart;

    for (var i: i32 = 0; i < maxSteps; i++) {
        prevVP     = currentVP;
        currentVP += viewDir * stepSize;

        // Clip to near plane
        if (currentVP.z > -0.01) { break; }

        let scr = viewToScreen(currentVP);

        // Out of screen
        if (scr.x < 0.0 || scr.x > 1.0 || scr.y < 0.0 || scr.y > 1.0) { break; }

        let sceneDep = textureSampleLevel(gLinearDepth, samplerGBuffer, scr.xy, 0.0).r;

        // Adaptive thickness: wider slab at distance prevents false misses and
        // false positives — scales proportionally with the linear depth value.
        let adaptiveThickness = ssrParams.thickness * (1.0 + sceneDep * 8.0);

        if (scr.z > sceneDep && (scr.z - sceneDep) < adaptiveThickness) {
            // Binary search refinement
            let refinedVP  = binarySearchRefine(prevVP, currentVP);
            let refinedScr = viewToScreen(refinedVP);

            var hitUV = refinedScr.xy;
            if (hitUV.x < 0.0 || hitUV.x > 1.0 || hitUV.y < 0.0 || hitUV.y > 1.0) { return vec4<f32>(0.0); }

            let hitColor  = textureSampleLevel(accLight, samplerGBuffer, hitUV, 0.0);
            let hitDist   = length(currentVP - viewStart);
            // Confidence factors — all three gate the alpha that ambient_specular.fs uses
            // to blend SSR against the IBL cubemap fallback: mix(ibl, ssr, confidence).
            let distFade  = 1.0 - saturate(hitDist / maxDistance);  // distant hits fade to IBL
            let edgeFade  = calculateEdgeFade(hitUV);                // screen-border hits fade to IBL
            let roughFade = 1.0 - smoothstep(0.0, 0.4, roughness);   // rough surfaces fall back to IBL
            let finalFade = edgeFade * roughFade;//distFade not used
            return vec4<f32>(hitColor.rgb, finalFade);
        }
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

    // Cheap sky / disabled early exit
    let rawDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).r;
    if (ssrParams.enabled < 0.5 || rawDepth >= 0.9999) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    let g = decodeGBuffer(uv);

    // Soft metallic fade: ramps 0→1 between metallic 0.1 and 0.4, giving smooth
    // SSR entry on partially metallic materials instead of a hard cutoff.
    // Hard roughness cutoff (roughnessMax ≈ 0.85) — roughFade inside the march already
    // smoothsteps confidence to 0 at roughness=0.4 and ambient_specular.fs blends
    // the remainder against the IBL cubemap, so fully wasted dispatches are avoided.
    let metallicFade = saturate((g.metallic - 0.1) / 0.3);
    if (g.metallic < ssrParams.metallicMin || g.roughness > ssrParams.roughnessMax) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    // Mip-smoothed normal for ray direction — suppresses normal-map high-frequency
    // detail that causes adjacent pixels to fire divergent rays (sparkle noise).
    // Rougher surfaces sample higher mips for more spatially averaged normals.
    // Sample at unjittered UV: the GBuffer was rendered with camera jitter, so the
    // texel addressed by `uv` shifts ±½ pixel every frame → the decoded normal
    // oscillates slightly → reflection direction changes → different ray hits each
    // frame → visible vibration.  Removing the jitter keeps the sample stable.
    let uvNoJitter    = vec2<f32>(uv.x - camera.jitterOffset.x, uv.y + camera.jitterOffset.y);
    let smoothMip     = clamp(1.0 + g.roughness * 3.0, 1.0, 5.0);
    let smoothNData   = textureSampleLevel(gNormals, samplerGBuffer, uvNoJitter, smoothMip);
    let smoothN       = normalize(octahedral01ToNormal(smoothNData.xy));
    let incidentDir   = normalize(g.worldPos - camera.cameraPosition.xyz);
    let smoothReflDir = normalize(reflect(incidentDir, smoothN));

    // Raw hit color — BRDF applied once in ambient_specular.fs (with Kulla-Conty).
    // metallicFade baked into alpha for smooth SSR entry on partially metallic surfaces.
    let result = performSSRMarch(g.worldPos, smoothReflDir, g.zlinear, g.roughness);
    textureStore(outputSSR, coords, vec4<f32>(result.rgb, result.a * metallicFade));
}
