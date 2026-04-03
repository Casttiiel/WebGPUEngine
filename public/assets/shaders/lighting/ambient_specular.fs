#include "common/uniforms"
#include "common/structs"
#include "common/pbr/core"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/pcc"

// Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var samplerGBuffer: sampler;      // Shared sampler

// SSR Parameters
@group(2) @binding(0) var ssrTexture: texture_2d<f32>;
@group(2) @binding(1) var ssrSampler: sampler;
@group(2) @binding(2) var aoTexture: texture_2d<f32>;
@group(2) @binding(3) var brdfLUT: texture_2d<f32>;
@group(2) @binding(4) var texSampler: sampler;
@group(2) @binding(5) var txEnvironment: texture_cube<f32>;
@group(2) @binding(6) var envSampler: sampler;
@group(2) @binding(7) var<uniform> ssrParams: SSRUniforms;

// Parallax Corrected Cubemap data for the two dominant reflection probes.
// hasProbeA/B (w component): 1.0 = probe active, 0.0 = use raw R or global env.
struct PCCSpecularUniforms {
    probeAPos: vec4<f32>,   // xyz = world pos, w = hasProbeA
    probeAMin: vec4<f32>,
    probeAMax: vec4<f32>,
    probeBPos: vec4<f32>,   // xyz = world pos, w = hasProbeB
    probeBMin: vec4<f32>,
    probeBMax: vec4<f32>,
    blendWeight: f32, _pad0: f32, _pad1: f32, _pad2: f32,
}
@group(2) @binding(8) var<uniform> pccData: PCCSpecularUniforms;

// Per-probe prefiltered env cubemaps for PCC specular.
// When no probe is active these point to the global env (bound by CPU as fallback).
@group(2) @binding(9)  var probeEnvA: texture_cube<f32>;
@group(2) @binding(10) var probeEnvB: texture_cube<f32>;



fn computeSpecularOcclusion(ao: f32, NoV: f32, roughness: f32) -> f32 {
    let exponent: f32 = exp2((-16.0 * roughness) - 1.0);
    let so: f32 = clamp((pow((NoV + ao), exponent) - 1.0) + ao, 0.0, 1.0);
    return so;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    if (g.zlinear > 0.999) { discard; }

    let aoSample = textureSampleLevel(aoTexture, texSampler, uv, 0.0);
    let ao  = aoSample.b;
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NoV = max(dot(N, V), 0.0);
    let so  = computeSpecularOcclusion(ao, NoV, g.roughness);

    let R = normalize(g.reflectedDir);

    // ── Parallax Corrected directions for probe A and probe B ─────────────────
    // probeXPos.w encoding: 0=no probe, 1=outdoor(no PCC), 2=indoor(PCC)
    let R_a = select(
        R,
        parallaxCorrectDir(g.worldPos, R, pccData.probeAPos.xyz,
                           pccData.probeAMin.xyz, pccData.probeAMax.xyz),
        pccData.probeAPos.w > 1.5,  // only apply PCC for indoor probes
    );
    let R_b = select(
        R,
        parallaxCorrectDir(g.worldPos, R, pccData.probeBPos.xyz,
                           pccData.probeBMin.xyz, pccData.probeBMax.xyz),
        pccData.probeBPos.w > 1.5,
    );

    // ── Shared split-sum BRDF — computed once for both IBL and SSR paths ──────
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NoV, 0.0, 1.0));
    let brdf  = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    let F0    = g.specularColor;
    let F     = Fresnel_Schlick_Roughness(NoV, F0, g.roughness);
    // Kulla-Conty multi-scattering energy compensation (Turquin 2019)
    let E    = brdf.x + brdf.y;
    let Ems  = 1.0 - E;
    let Favg = F0 + (1.0 - F0) / 21.0;
    let Fms  = Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let splitSum = F * brdf.x + brdf.y + Fms;

    // ── IBL: per-probe prefiltered env with PCC, blended, fallback to global ──
    let maxMipLevel = 7.0;
    let mipLevel    = g.roughness * maxMipLevel;

    let envGlobal = textureSampleLevel(txEnvironment, envSampler, R,   mipLevel).rgb;
    let envA      = textureSampleLevel(probeEnvA,     envSampler, R_a, mipLevel).rgb;
    let envB      = textureSampleLevel(probeEnvB,     envSampler, R_b, mipLevel).rgb;

    // Select: no probe → global env; probe active → probe env (PCC or not); A+B → blend
    let hasA        = pccData.probeAPos.w > 0.5;  // w > 0 means any probe
    let hasB        = pccData.probeBPos.w > 0.5;
    let envBlended  = mix(envA, envB, pccData.blendWeight);
    let envRadiance = select(select(envGlobal, envA, hasA), envBlended, hasA && hasB);

    let iblSpecular = envRadiance * splitSum;

    // ── SSR: raw hit radiance × same split-sum BRDF (same energy space as IBL) ─
    let ssrColor    = textureSample(ssrTexture, ssrSampler, uv);
    let ssrAlpha    = ssrColor.a;
    let ssrSpecular = ssrColor.rgb * splitSum;

    let finalSpecular = mix(iblSpecular, ssrSpecular, ssrAlpha) * ssrParams.specularBoost;

    // Alpha = average specular energy × specular occlusion.
    // With additive_by_src_alpha: dst += finalSpecular * alpha
    // → rough=1 or occluded surfaces contribute nothing, metals/glossy contribute fully.
    let specularEnergy = dot(splitSum, vec3<f32>(0.333));
    return vec4<f32>(finalSpecular, specularEnergy * so);
}