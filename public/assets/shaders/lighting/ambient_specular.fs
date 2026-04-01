#include "common/uniforms"
#include "common/structs"
#include "common/pbr/core"
#include "common/octahedral"
#include "common/gbuffer"

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

    // ── IBL: prefiltered env radiance × split-sum BRDF ────────────────────────
    let maxMipLevel = 7.0;
    let mipLevel    = g.roughness * maxMipLevel;
    let envRadiance = textureSampleLevel(txEnvironment, envSampler, R, mipLevel).rgb;
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