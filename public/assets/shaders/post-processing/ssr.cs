// Screen-Space Reflections — compute shader
// Ray marching logic ported from the original ssr.fs (world-space per-step march).
// Compute wrapper keeps the STORAGE_BINDING output and eliminates fullscreen quad overhead.
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

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fadeX = min(uv.x / fadeWidth, (1.0 - uv.x) / fadeWidth);
    let fadeY = min(uv.y / fadeWidth, (1.0 - uv.y) / fadeWidth);
    return min(fadeX, fadeY);
}

fn performScreenSpaceRayMarching(
    startPos:   vec3<f32>,
    rayDir:     vec3<f32>,
    startUV:    vec2<f32>,
    startDepth: f32,
) -> vec4<f32> {
    let stepSize    = ssrParams.stepSize;
    let maxSteps    = i32(ssrParams.maxSteps);
    let maxDistance = ssrParams.maxDistance;

    var currentPos = startPos;

    for (var i = 0; i < maxSteps; i++) {

        currentPos += rayDir * stepSize;

        let currentDistance = length(currentPos - startPos);
        if (currentDistance > maxDistance) { break; }

        let viewPos = camera.viewMatrix * vec4<f32>(currentPos, 1.0);
        if (viewPos.z > 0.0) { break; }

        // Project to screen space
        let clipPos  = camera.projectionMatrix * viewPos;
        let ndc      = clipPos.xyz / clipPos.w;
        var screenUV = ndc.xy * 0.5 + 0.5;
        screenUV.y   = 1.0 - screenUV.y;

        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) { break; }

        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let camb2obj     = currentPos - camera.cameraPosition.xyz;
        let currentDepth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;

        if (currentDepth > sampledDepth
            && (currentDepth - sampledDepth) < ssrParams.thickness
            && sampledDepth > startDepth)
        {
            let hitColor  = textureSampleLevel(accLight, texSampler, screenUV, 0.0);
            let distFade  = 1.0 - (currentDistance / maxDistance);
            let edgeFade  = calculateEdgeFade(screenUV);
            let stepFade  = 1.0 - (f32(i) / f32(maxSteps));
            let finalFade = clamp(distFade * edgeFade * stepFade, 0.0, 1.0);
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

    if (g.metallic < 0.1 || g.roughness > 0.9) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    let result       = performScreenSpaceRayMarching(g.worldPos, g.reflectedDir, uv, g.zlinear);
    let contribution = applyFresnelBRDF(result.rgb, g);
    textureStore(outputSSR, coords, vec4<f32>(contribution, result.a));
}
