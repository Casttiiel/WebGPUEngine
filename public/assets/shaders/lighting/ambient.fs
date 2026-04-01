#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"

struct AmbientUniforms {
    globalAmbientBoost: f32,
    diffuseBoost:       f32,
    padding:        f32,
    padding2:      f32, 
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var gAO:        texture_2d<f32>;
@group(2) @binding(1) var samplerEnv:  sampler;
@group(2) @binding(2) var<uniform> ambient: AmbientUniforms;
@group(2) @binding(3) var irradianceMap:     texture_cube<f32>;
@group(2) @binding(4) var samplerIrradiance: sampler;


fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NdV = max(dot(N, V), 0.0);

    let irradianceDir = N;
    let irradiance = textureSample(irradianceMap, samplerIrradiance, irradianceDir).rgb;
    let F0  = g.specularColor;
    let F   = Fresnel_Schlick_Roughness(NdV, F0, g.roughness);
    let kS  = F;
    let kD  = (1.0 - kS) * (1.0 - g.metallic);
    let diffuse = kD * Diffuse(g.albedo) * irradiance;

    return diffuse * ambient.diffuseBoost * ambient.globalAmbientBoost * ao;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {   
    let g  = decodeGBuffer(uv);
    let aoSample = textureSample(gAO, samplerEnv, uv);
    let ao = aoSample.b;  // AO scalar packed in .b

    let ibl = calculateIBL(g, ao);

    return vec4<f32>(ibl + g.selfIllum, 1.0);
}