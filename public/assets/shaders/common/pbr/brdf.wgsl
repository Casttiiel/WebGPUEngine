// Complete BRDF calculations for PBR lighting
// Level 3: Depends on pbr/core

#include "common/pbr/core"

// Cook-Torrance Specular BRDF
fn Specular(specularColor: vec3<f32>, h: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughnessSquared: f32, NdL: f32, NdV: f32, NdH: f32, VdH: f32, LdV: f32) -> vec3<f32> {
    let F0 = specularColor;
    let roughness = sqrt(roughnessSquared);
    
    let NDF = NormalDistribution_GGX(NdH, roughness);
    let G = Geometric_Smith_Schlick_GGX(NdV, NdL, roughness);
    let F = Fresnel_Schlick(VdH, F0);
    
    let numerator = NDF * G * F;
    let denominator = 4.0 * NdV * NdL + EPSILON;
    
    return numerator / denominator;
}

// Lambertian Diffuse BRDF
fn Diffuse(pAlbedo: vec3<f32>) -> vec3<f32> {
    return pAlbedo * INV_PI;
}

// Half Lambert: remaps NdL [0,1] → [0.25,1] to soften the shadow terminator
// and wrap light around the back of surfaces. Based on Valve's HL2 technique.
fn halfLambert(NdL: f32) -> f32 {
    let h = NdL * 0.5 + 0.5;
    return h * h;
}

// Micro-shadow term (Jimenez 2016, "Practical Realtime Strategies for Accurate
// Indirect Occlusion", eq. 18).
// Converts baked AO to the cosine of the hemisphere cone half-angle and compares
// it against NdotL so that geometry encoded in normal/AO maps casts a shadow on
// direct illumination — at essentially zero GPU cost (one sqrt + one divide).
//
// ao    : AO value [0..1], where 0 = fully occluded, 1 = fully exposed.
// NdotL : dot(N, L) clamped to [0..1].
// Returns a visibility factor in [0..1] that attenuates the direct contribution
// in concave areas without affecting IBL (which is already modulated by AO).
fn microShadow(ao: f32, NdotL: f32) -> f32 {
    let cosTheta = sqrt(1.0 - ao);   // cos of AO cone half-angle (eq. 18)
    return saturate(NdotL / (cosTheta + 0.0001));
}
