// Complete BRDF calculations for PBR lighting
// Level 3: Depends on pbr/core

// Core PBR functions: Normal Distribution, Geometry, Fresnel
// Level 2: Depends on core/constants

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

// Basic math utility functions
// Level 0: No dependencies

// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}


// GGX/Trowbridge-Reitz Normal Distribution Function
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a2 = roughness * roughness;
    let NdotH2 = NdotH * NdotH;
    
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    
    return num / denom;
}

// Smith-Schlick-GGX Geometry Function (Uncorrelated)
fn Geometric_Smith_Schlick_GGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    
    let ggx2 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx1 = NdotL / (NdotL * (1.0 - k) + k);
    
    return ggx1 * ggx2;
}

// Smith-GGX Geometry Function (Height-Correlated)
fn Geometry_SmithGGX_Correlated(NdV: f32, NdL: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let gv = NdL * sqrt(NdV * (NdV - NdV * a) + a);
    let gl = NdV * sqrt(NdL * (NdL - NdL * a) + a);
    return 0.5 / max(gv + gl, EPSILON);
}

// Schlick's Fresnel approximation
fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

// Fresnel with roughness factor for IBL
fn Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let oneMinusRoughness = 1.0 - roughness;
    return F0 + (max(vec3f(oneMinusRoughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


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
