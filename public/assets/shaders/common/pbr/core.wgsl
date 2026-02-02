// Core PBR functions: Normal Distribution, Geometry, Fresnel
// Level 2: Depends on core/constants

#include "common/core/constants"
#include "common/math/utils"

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
