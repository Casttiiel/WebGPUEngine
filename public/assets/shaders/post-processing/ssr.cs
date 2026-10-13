// ---------------------------------------------------------------------------
// Stochastic Screen-Space Reflections — compute shader
// Port of three.js SSRNode with `stochastic: true` (examples/jsm/tsl/display/SSRNode.js):
//   • one GGX bounded-VNDF reflection ray per pixel (mirror-biased), every surface
//   • fixed step count (quality · 64) with exponential distribution + jitter
//   • view-space thickness test (point-to-line distance, ≥ ~3 px)
//   • screen-edge fade and misses resolve to the environment
//   • multi-bounce: the previous frame's denoised SSR is folded in at the hit point
//
// Environment: instead of three.js' importance-sampled equirect HDR, misses and edge
// fades use the same prefiltered cubemaps as ambient_specular.fs (global env + the two
// dominant PCC reflection probes), so SSR on/off stays energy-consistent with the IBL.
//
// Output (rgba16float): rgb = incoming radiance along the reflection,
//                       a   = world-space ray length (ENV_RAY_LENGTH on misses).
// The radiance is NOT weighted by the BRDF: ambient_specular.fs multiplies it by the
// split-sum term, exactly like the IBL radiance it replaces.
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/octahedral"
#include "common/pcc"
#include "post-processing/ssr_common"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

struct PCCSpecularUniforms {
    probeAPos: vec4<f32>,   // xyz = world pos, w: 0 = none, 1 = outdoor, 2 = indoor (PCC)
    probeAMin: vec4<f32>,
    probeAMax: vec4<f32>,
    probeBPos: vec4<f32>,
    probeBMin: vec4<f32>,
    probeBMax: vec4<f32>,
    blendWeight: f32, _pad0: f32, _pad1: f32, _pad2: f32,
}

@group(2) @binding(0) var accLight:            texture_2d<f32>;
@group(2) @binding(1) var<uniform> params:     SSRTraceParams;
@group(2) @binding(2) var txEnvironment:       texture_cube<f32>;
@group(2) @binding(3) var probeEnvA:           texture_cube<f32>;
@group(2) @binding(4) var probeEnvB:           texture_cube<f32>;
@group(2) @binding(5) var envSampler:          sampler;
@group(2) @binding(6) var<uniform> pccData:    PCCSpecularUniforms;
@group(2) @binding(7) var historyTex:          texture_2d<f32>; // last frame's denoised SSR
@group(2) @binding(8) var brdfLUT:             texture_2d<f32>;
@group(2) @binding(9) var linearSampler:       sampler;

@group(3) @binding(0) var outputSSR: texture_storage_2d<rgba16float, write>;

const MAX_STEPS: f32 = 64.0;

// Prefiltered environment radiance along the mirror direction — identical to the IBL
// lookup in ambient_specular.fs (probe blend + parallax correction).
fn sampleEnvironment(worldPos: vec3<f32>, R: vec3<f32>, roughness: f32) -> vec3<f32> {
    let R_a = select(R, parallaxCorrectDir(worldPos, R, pccData.probeAPos.xyz,
                                           pccData.probeAMin.xyz, pccData.probeAMax.xyz),
                     pccData.probeAPos.w > 1.5);
    let R_b = select(R, parallaxCorrectDir(worldPos, R, pccData.probeBPos.xyz,
                                           pccData.probeBMin.xyz, pccData.probeBMax.xyz),
                     pccData.probeBPos.w > 1.5);
    let mip = roughness * params.envMaxMip;
    let envGlobal = textureSampleLevel(txEnvironment, envSampler, R,   mip).rgb;
    let envA      = textureSampleLevel(probeEnvA,     envSampler, R_a, mip).rgb;
    let envB      = textureSampleLevel(probeEnvB,     envSampler, R_b, mip).rgb;
    let hasA = pccData.probeAPos.w > 0.5;
    let hasB = pccData.probeBPos.w > 0.5;
    let envBlended = mix(envA, envB, pccData.blendWeight);
    return select(select(envGlobal, envA, hasA), envBlended, hasA && hasB);
}

// Indirect specular the hit surface reflects toward the ray origin, from last frame's
// denoised SSR (reprojected to the hit point). accLight lacks indirect specular — it is
// added by ambient_specular.fs after SSR — so this supplies the second bounce. Weighted by
// the hit surface's split-sum BRDF (same as ambient_specular.fs) and faded by (1 - a),
// where a = 1 / frames, so freshly disoccluded history does not feed back.
fn multiBounce(hitUv: vec2<f32>, hitWorldPosition: vec3<f32>) -> vec3<f32> {
    let historyUV = ssrProjectToPrevUV(hitWorldPosition);
    if (params.historyValid < 0.5 || !ssrUvInside(historyUV)) { return vec3<f32>(0.0); }
    let history = max(textureSampleLevel(historyTex, linearSampler, historyUV, 0.0), vec4<f32>(0.0));

    let nData   = textureLoad(gNormals, ssrGBufferCoord(gNormals, hitUv), 0);
    let albedo  = textureLoad(gAlbedo, ssrGBufferCoord(gAlbedo, hitUv), 0);
    let N  = octahedral01ToNormal(nData.xy);
    let r  = max(nData.z, 0.045);
    let F0 = mix(vec3<f32>(0.04), albedo.rgb, albedo.a);
    let V  = normalize(camera.cameraPosition.xyz - hitWorldPosition);
    let NoV = clamp(dot(N, V), 0.0, 1.0);
    let brdf = textureSampleLevel(brdfLUT, linearSampler, vec2<f32>(NoV, 1.0 - r), 0.0).rg;
    let F    = F0 + (max(vec3<f32>(1.0 - r), F0) - F0) * pow(1.0 - NoV, 5.0);
    // Kulla-Conty multi-scattering compensation, as in ambient_specular.fs
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = F0 + (1.0 - F0) / 21.0;
    let Fms  = Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let splitSum = F * brdf.x + brdf.y + Fms;

    return history.rgb * splitSum * params.specularBoost * (1.0 - history.a);
}

fn pointToLineDistance(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
    return length(cross(p - a, p - b)) / length(b - a);
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims   = vec2<i32>(textureDimensions(outputSSR));
    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dims.x || coords.y >= dims.y) { return; }

    let resolution = vec2<f32>(dims);
    let uv = (vec2<f32>(coords) + 0.5) / resolution;

    let depth = ssrSampleDepth(uv);
    if (depth >= 1.0 || depth <= 0.0001) {
        textureStore(outputSSR, coords, vec4<f32>(0.0, 0.0, 0.0, ENV_RAY_LENGTH)); // background
        return;
    }

    // ── Surface ───────────────────────────────────────────────────────────────
    let gCoord     = ssrGBufferCoord(gNormals, uv);
    let normalData = textureLoad(gNormals, gCoord, 0);
    let worldNormal = octahedral01ToNormal(normalData.xy);
    let roughness  = max(normalData.z, 0.045); // same clamp as decodeGBuffer

    let viewPosition  = ssrViewPosition(uv, depth);
    let worldPosition = (camera.invView * vec4<f32>(viewPosition, 1.0)).xyz;
    let viewNormal    = normalize((camera.viewMatrix * vec4<f32>(worldNormal, 0.0)).xyz);
    let viewIncidentDir = normalize(viewPosition);
    let V = -viewIncidentDir;

    // Mirror direction (world) for the prefiltered environment fallback
    let worldIncident = normalize(worldPosition - camera.cameraPosition.xyz);
    let worldMirrorR  = normalize(reflect(worldIncident, worldNormal));
    let envColor = sampleEnvironment(worldPosition, worldMirrorR, roughness);

    // ── Stochastic GGX ray ────────────────────────────────────────────────────
    var Xi = ssrAnalyticNoise(uv * resolution, i32(params.noiseIndex), 47.0);
    // Mirror bias: pull Xi.y toward the cap top to tighten the lobe (less mid-roughness noise).
    Xi.y = mix(Xi.y, 0.0, params.mirrorBias * sqrt(Xi.w));

    var viewReflectDir = ssrGGXReflectionDir(viewNormal, V, roughness, Xi);
    // The GGX sample can face away from the surface — re-sample once.
    if (dot(viewReflectDir, viewNormal) < 0.0) {
        viewReflectDir = ssrGGXReflectionDir(viewNormal, V, roughness, fract(Xi * 8.0));
    }

    let NoV = max(dot(viewNormal, V), 0.0);
    let specDominantFactor = ssrSpecularDominantFactor(NoV, roughness);
    let glossiness     = 1.0 - min(roughness / 0.25, 1.0);
    let hitBorderWidth = params.screenEdgeFade * glossiness;

    // ── Ray setup (screen space) ──────────────────────────────────────────────
    let maxReflectRayLen = params.maxDistance / max(dot(-viewIncidentDir, viewNormal), 1e-3);
    var d1viewPosition = viewPosition + viewReflectDir * maxReflectRayLen;
    // Clamp the end point to the near plane
    if (d1viewPosition.z > -params.cameraNear) {
        let t = (-params.cameraNear - viewPosition.z) / viewReflectDir.z;
        d1viewPosition = viewPosition + viewReflectDir * t;
    }

    let d0 = uv * resolution;
    let d1 = ssrScreenFromClip(camera.projectionMatrix * vec4<f32>(d1viewPosition, 1.0)) * resolution;
    let rayVec = d1 - d0;
    let rayLen = max(max(abs(rayVec.x), abs(rayVec.y)), 1.0);

    let totalStep = i32(max(clamp(params.quality, 0.0, 1.0) * MAX_STEPS, 1.0));
    let invResolution = 1.0 / resolution;

    // Reflected-ray view Z at parameter s ∈ [0,1] (linear in 1/z for perspective)
    let recipVPZ   = 1.0 / viewPosition.z;
    let recipD1VPZ = 1.0 / d1viewPosition.z;

    // ── March ────────────────────────────────────────────────────────────────
    var foundHit = false;
    var hitUv    = vec2<f32>(0.0);
    var hitDepth = 0.0;

    for (var i = 1; i < totalStep; i++) {
        // Exponential remap concentrating samples near the origin, floored to ≥ 1 texel/step;
        // the jitter (noise.z) dissolves banding.
        let fi = f32(i);
        let s  = max(pow((fi + Xi.z - 0.5) / f32(totalStep), params.stepExponent), fi / rayLen);
        let xy = d0 + rayVec * s;
        if (xy.x < 0.0 || xy.x > resolution.x || xy.y < 0.0 || xy.y > resolution.y) { break; }

        let uvS = xy * invResolution;
        let d   = ssrSampleDepth(uvS);
        let vZ  = -d * camera.cameraFar;
        let rayZ = 1.0 / (recipVPZ + s * (recipD1VPZ - recipVPZ));

        if (rayZ <= vZ) {
            // Depth crossing: gate by thickness so an occluder gap doesn't stop the march.
            let vP   = ssrViewPosition(uvS, d);
            let away = pointToLineDistance(vP, viewPosition, d1viewPosition);
            let vPNeighbor   = ssrViewPosition(uvS + vec2<f32>(invResolution.x, 0.0), d);
            let minThickness = (vPNeighbor.x - vP.x) * 3.0;
            if (away <= max(minThickness, params.thickness)) {
                foundHit = true;
                hitUv    = uvS;
                hitDepth = d;
                break;
            }
        }
    }

    // ── Shade ────────────────────────────────────────────────────────────────
    var output = vec4<f32>(envColor, ENV_RAY_LENGTH);
    if (foundHit) {
        let vP = ssrViewPosition(hitUv, hitDepth);
        let hitWorldPosition = (camera.invView * vec4<f32>(vP, 1.0)).xyz;
        let worldDistance = distance(worldPosition, hitWorldPosition) * specDominantFactor;

        var reflectColor = textureLoad(accLight, ssrGBufferCoord(accLight, hitUv), 0).rgb;
        if (params.multiBounce > 0.5) {
            reflectColor += multiBounce(hitUv, hitWorldPosition);
        }
        // Fade toward the environment as the hit approaches a screen border
        let hitBorderFactor = ssrScreenBorderFactor(hitUv, hitBorderWidth);
        if (hitBorderFactor < 1.0) {
            reflectColor = mix(envColor, reflectColor, hitBorderFactor);
        }
        output = vec4<f32>(reflectColor, worldDistance);
    }

    // Firefly control: cap absolute luminance (hue preserved), then user intensity
    let lum = max(ssrLuminance(output.rgb), 1e-4);
    output = vec4<f32>(output.rgb * min(params.maxLuminance / lum, 1.0) * params.intensity, output.a);

    textureStore(outputSSR, coords, max(output, vec4<f32>(0.0)));
}
