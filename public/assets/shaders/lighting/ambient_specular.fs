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

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N     = normalize(g.normal);
    let V     = normalize(g.viewDir);    
    let NdotV = max(dot(N, V), 0.0);
    let F0    = g.specularColor;
    let F     = Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdotV, 0.0, 1.0));
    let brdf  = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;

    // Kulla-Conty multi-scattering energy compensation.
    // Single-scatter GGX does not integrate to 1 over the hemisphere — the missing
    // energy grows with roughness and makes rough metals appear too dark.
    // We add the multi-scatter complement using the average-Fresnel approximation:
    //   E(NdV)  = brdf.x + brdf.y   (total single-scatter directional albedo)
    //   E_ms    = 1 - E             (missing energy fraction)
    //   F_avg   = F0 + (1-F0)/21   (hemisphere-average Fresnel)
    //   f_ms    = F_avg*E_ms / (1 - F_avg*E_ms)   (Turquin 2019)
    let E    = brdf.x + brdf.y;
    let Ems  = 1.0 - E;
    let Favg = F0 + (1.0 - F0) / 21.0;
    let Fms  = Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));

    return color * (F * brdf.x + brdf.y + Fms);
}

fn computeSpecularOcclusion(ao: f32, NoV: f32, roughness: f32) -> f32 {
    let exponent: f32 = exp2((-16.0 * roughness) - 1.0);
    let so: f32 = clamp((pow((NoV + ao), exponent) - 1.0) + ao, 0.0, 1.0);
    return so;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    if(g.zlinear > 0.999){
        discard;
    }
    let aoSample = textureSampleLevel(aoTexture, texSampler, uv, 0.0);
    let ao  = aoSample.b;  // AO scalar packed in .b
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);
    let NoV = max(dot(N, V), 0.0);
    let so = computeSpecularOcclusion(ao, NoV, g.roughness);

    // Decode bent normal (view-space) and transform to world space for cubemap sampling
    let bentNormalVS = octahedral01ToNormal(aoSample.rg);
    let bentNormalWS = normalize((camera.invView * vec4<f32>(bentNormalVS, 0.0)).xyz);

    // Reflection direction: blend geometric reflection toward bent-normal reflection.
    // Smooth surfaces (narrow specular lobe) benefit most from per-pixel correcton.
    // Occluded surfaces pull toward unoccluded hemisphere captured by bent normal.
    let R_geom = normalize(g.reflectedDir);
    let R_bent = reflect(-g.viewDir, bentNormalWS);
    let bentBlend = saturate(1.0 - ao) * g.roughness;
    var R = normalize(mix(R_geom, R_bent, bentBlend));

    let avgF0 = dot(g.specularColor, vec3<f32>(0.333));
    let specularStrength = max(avgF0, g.metallic) * (1.0 - g.roughness * 0.8);

    // SSR color y alpha
    let ssrColor = textureSample(ssrTexture, ssrSampler, uv);
    let ssrAlpha = ssrColor.a;

    // Pre-filtered specular IBL: sample mip proportional to roughness (split-sum approximation).
    let maxMipLevel = 7.0;
    let mipLevel = g.roughness * maxMipLevel;
    let fallbackColor = textureSampleLevel(txEnvironment, envSampler, R, mipLevel).rgb * ssrParams.globalAmbientBoost;

    // IBL: raw prefiltered radiance needs full split-sum BRDF applied
    let iblSpecular = applyFresnelBRDF(fallbackColor, g);

    // SSR: already contains full specular response (its own Fresnel baked in at ray march time).
    // Re-apply only the split-sum weight so both paths share the same scale.
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NoV, 0.0, 1.0));
    let brdf       = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    let F          = Fresnel_Schlick_Roughness(NoV, g.specularColor, g.roughness);
    let ssrSpecular = ssrColor.rgb * F;

    var finalSpecular = mix(iblSpecular, ssrSpecular, ssrAlpha) * ssrParams.specularBoost * so;

    // Composición final: suma a la escena base fuera de este shader.
    // Blend mode = additive_by_src_alpha → dst += finalSpecular * alpha.
    // specularStrength gates dielectrics out (metallic=0 → alpha=0 → nothing added)
    // and scales rough metal specular down proportionally to roughness.
    return vec4<f32>(finalSpecular, specularStrength);
}