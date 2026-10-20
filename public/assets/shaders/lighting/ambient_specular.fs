#include "common/uniforms"
#include "common/structs"
#include "common/pbr/core"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/probes_specular"

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

// Reflection probes (per pixel, see common/probes.wgsl).
@group(2) @binding(8) var<storage, read> probeSet: ProbeSet;
@group(2) @binding(9) var probeEnvArray: texture_cube_array<f32>;

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

    // ── Shared split-sum BRDF — computed once for both IBL and SSR paths ──────
    let brdfCoords = vec2<f32>(clamp(NoV, 0.0, 1.0), 1.0 - clamp(g.roughness, 0.0, 1.0));
    let brdf  = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    let F0    = g.specularColor;
    // The LUT already integrates Fresnel over the lobe: single scatter = F0·A + B (Karis).
    let FssEss = F0 * brdf.x + brdf.y;
    // Multi-scattering energy compensation (Fdez-Agüera 2019, as in three.js)
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = F0 + (1.0 - F0) / 21.0;
    let Fms  = FssEss * Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let splitSum = FssEss + Fms;

    // ── IBL: per-pixel probe blend (PCC indoors), global env where none covers ──
    let maxMipLevel = 7.0;
    let mipLevel    = g.roughness * maxMipLevel;

    let envGlobal   = textureSampleLevel(txEnvironment, envSampler, R, mipLevel).rgb;
    // The probe cubemaps have their own mip chain (prefiltered at ProbeManager.ENV_SIZE).
    let envRadiance = probeSpecular(g.worldPos, R, g.roughness * probeSet.envMaxMip, envSampler, envGlobal);

    let iblSpecular = envRadiance * ssrParams.environmentIntensity * splitSum;

    // ── SSR: reflected radiance × same split-sum BRDF (same energy space as IBL) ─
    // The stochastic SSR resolves screen misses and edge fades to this same prefiltered
    // environment, so when enabled it fully replaces the IBL radiance. Its alpha holds the
    // temporal accumulation speed, not a hit mask.
    let ssrColor    = textureSample(ssrTexture, ssrSampler, uv);
    let ssrSpecular = ssrColor.rgb * splitSum;

    let finalSpecular = select(iblSpecular, ssrSpecular, ssrParams.enabled > 0.5) * ssrParams.specularBoost;

    // The BRDF is already in finalSpecular — weighting alpha by it again would apply it twice.
    // With additive_by_src_alpha: dst += finalSpecular * alpha.
    // Specular occlusion only stands in for the local geometry the cubemap can't see; SSR
    // traces that geometry (its hits are already occluded), so it isn't darkened twice.
    let occlusion = select(so, 1.0, ssrParams.enabled > 0.5);
    return vec4<f32>(finalSpecular, occlusion);
}
