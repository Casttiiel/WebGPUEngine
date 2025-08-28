#include "common/uniforms"
#include "common/structs"
#include "common/utils"
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

fn applyAmbientOcclusion(color: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    let ao = textureSampleLevel(aoTexture, texSampler, uv, 0.0).r;
    return color * ao * ssrParams.globalAmbientBoost;
}

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);    
    let NdotV = max(dot(N, V), 0.0);
    let F0 = mix(vec3<f32>(0.04), g.albedo, g.metallic);
    let F = Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdotV, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    return color * (F * brdf.x + brdf.y);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {

    let g = decodeGBuffer(uv);

    // Calculate reflection strength based on metallic/roughness
    let reflectionStrength = g.metallic * (1.0 - g.roughness);

    let ssrColor = textureSample(ssrTexture, ssrSampler, uv);


    // Early exit if SSR is disabled or almost no reflection or no hit found on SSR
    if (ssrParams.enabled < 0.5 || g.metallic < 0.1 || g.roughness > 0.9 || ssrColor.a < 0.01) {
        let R = normalize(g.reflectedDir);
        let maxMipLevel = 7.0;
        let mipLevel = g.roughness * maxMipLevel;
        let prefilteredColor = vec3<f32>(g.albedo) * 0.75;//textureSampleLevel(txEnvironment, envSampler, R, mipLevel).rgb;
        var color = applyFresnelBRDF(prefilteredColor, g);
        color = applyAmbientOcclusion(color, uv);
        return vec4<f32>(color, reflectionStrength);
    }

    return vec4<f32>(ssrColor);
}