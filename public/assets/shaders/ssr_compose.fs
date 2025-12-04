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

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);    
    let NdotV = max(dot(N, V), 0.0);
    let F0 = g.specularColor;
    let F = Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdotV, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    return color * (F * brdf.x + brdf.y);
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
    let ao = textureSampleLevel(aoTexture, texSampler, uv, 0.0).r;
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);
    let NoV = max(dot(N, V), 0.0);
    let so = computeSpecularOcclusion(ao, NoV, g.roughness);

    // Specular strength
    let specularStrength = g.metallic * (1.0 - g.roughness);

    // SSR color y alpha
    let ssrColor = textureSample(ssrTexture, ssrSampler, uv);
    let ssrAlpha = ssrColor.a;

    // Fallback: IBL/env map
    var R = normalize(g.reflectedDir);
    let maxMipLevel = 7.0;
    let mipLevel = g.roughness * maxMipLevel;
    let fallbackColorRaw = textureSampleLevel(txEnvironment, envSampler, R, mipLevel).rgb * ssrParams.globalAmbientBoost * ssrParams.diffuseBoost;
    let envTint = vec3<f32>(0.77, 0.7, 0.6); // Un leve tinte cálido, ajustable
    let fallbackColor = clamp(fallbackColorRaw * envTint, vec3<f32>(0.0), vec3<f32>(10.0));
    var fallbackSpecular = applyFresnelBRDF(fallbackColor, g);
    fallbackSpecular *= so;
    // SSR specular (también atenuado por SO)
    let ssrSpecular = ssrColor.rgb * so;

    // Mezcla SSR y fallback según alpha
    var finalSpecular = mix(fallbackSpecular, ssrSpecular, 0.0) * ssrParams.specularBoost;

    // Composición final: suma a la escena base fuera de este shader
    return vec4<f32>(finalSpecular, specularStrength * 1.0);
}