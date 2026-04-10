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
fn viewToScreen(viewPos: vec3<f32>) -> vec3<f32> {
    let clip  = camera.projectionMatrix * vec4<f32>(viewPos, 1.0);
    let ndc   = clip.xyz / clip.w;
    var uv    = ndc.xy * 0.5 + 0.5;
    uv.y      = 1.0 - uv.y;
    let depth = -viewPos.z / camera.cameraFar; // normalised linear depth [0,1]
    return vec3<f32>(uv, depth);
}

// ── View-space reconstruction: screen UV + linear depth → view-space position ──
// Inverse of viewToScreen's UV mapping.  Used to validate hits in 3D rather than
// comparing raw depth scalars that may belong to completely different objects
// (e.g. a near object A that projects onto the same UVs as the ray position B).
fn screenToView(uv: vec2<f32>, linearDepth: f32) -> vec3<f32> {
    let ndc   = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let viewZ = -linearDepth * camera.cameraFar;
    // Invert perspective: ndc.x = proj[0][0] * viewX / (-viewZ)
    //                  → viewX = ndc.x * (-viewZ) / proj[0][0]
    let viewX = ndc.x * (-viewZ) / camera.projectionMatrix[0][0];
    let viewY = ndc.y * (-viewZ) / camera.projectionMatrix[1][1];
    return vec3<f32>(viewX, viewY, viewZ);
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
        let midThickness = ssrParams.thickness * (1.0 + sceneDep * 2.0);
        // Use crossing condition consistent with the march: penetrating → refine
        // from the hi side; in front or beyond slab → push lo forward.
        if (midScr.z > sceneDep && (midScr.z - sceneDep) < midThickness) {
            hi = midVP; // mid is inside the hit slab → move hi back
        } else {
            lo = midVP; // mid is in front or past the slab → move lo forward
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

    // Normalized depth of the reflection surface, used below to reject hits on
    // objects that are closer to the camera than the reflector itself.
    let rayStartDepth = -viewStartRaw.z / camera.cameraFar;

    // Offset by a fixed world-space bias to avoid self-intersection — independent
    // of stepSize so that small steps don't leave the ray inside the surface and
    // large steps don't skip valid close hits.
    let viewStart = viewStartRaw + viewDir * 0.05;
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

        // Adaptive thickness: slightly wider slab at distance, but conservatively
        // capped (2× instead of 8×) to avoid false hits on distant thin objects.
        let adaptiveThickness = ssrParams.thickness * (1.0 + sceneDep * 2.0);

        // 3-D proximity test: reconstruct the view-space position of the scene
        // surface at scr.xy, then measure how far it is from the ray line.
        // This rules out false positives caused by a near object A whose screen
        // projection overlaps the ray's projected UV even though the ray never
        // physically passes through A.  A pure depth comparison can't distinguish
        // that case because scr.xy may belong to a completely different object.
        let sceneViewPos = screenToView(scr.xy, sceneDep);
        let tScene       = dot(sceneViewPos - viewStart, viewDir);
        let lateralDist  = length(sceneViewPos - (viewStart + viewDir * tScene));

        // Valid hit conditions (all must hold):
        //  scr.z > sceneDep          — ray passed through the surface depth
        //  sceneDep > rayStartDepth  — the hit object is behind the reflector (not a closer occluder)
        //  tScene > 0.0              — object is ahead along the ray
        //  lateralDist < stepSize    — object is genuinely close to the ray in 3-D
        //  depth diff < thickness    — ray hasn't penetrated unrealistically deep
        if (scr.z > sceneDep
            && sceneDep > rayStartDepth
            && tScene > 0.0
            && lateralDist < stepSize
            && (scr.z - sceneDep) < adaptiveThickness) {
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
    let smoothMip     = clamp(1.0 + g.roughness * 3.0, 1.0, 5.0);
    let smoothNData   = textureSampleLevel(gNormals, samplerGBuffer, uv, smoothMip);
    let smoothN       = normalize(octahedral01ToNormal(smoothNData.xy));
    let incidentDir   = normalize(g.worldPos - camera.cameraPosition.xyz);
    let smoothReflDir = normalize(reflect(incidentDir, smoothN));

    // Raw hit color — BRDF applied once in ambient_specular.fs (with Kulla-Conty).
    // metallicFade baked into alpha for smooth SSR entry on partially metallic surfaces.
    let result = performSSRMarch(g.worldPos, smoothReflDir, g.zlinear, g.roughness);
    textureStore(outputSSR, coords, vec4<f32>(result.rgb, result.a * metallicFade));
}