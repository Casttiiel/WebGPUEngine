#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

struct AmbientUniforms {
    reflectionIntensity: f32,
    ambientLightIntensity: f32,
    globalAmbientBoost: f32,
    padding: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var gAO: texture_2d<f32>;
@group(2) @binding(1) var samplerEnv: sampler;
@group(2) @binding(2) var<uniform> ambient: AmbientUniforms;


fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N = normalize(g.normal);
    let irradiance = vec3<f32>(1.0); //textureSample(irradianceMap, samplerIrradiance, direction_to_equirect_uv(N)).rgb;

    let kD = 1.0 - g.metallic; // Only non-metals get diffuse
    let diffuse = kD * Diffuse(g.albedo) * irradiance;

    return diffuse * ambient.ambientLightIntensity * ambient.globalAmbientBoost * ao;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Decode GBuffer data
    let g = decodeGBuffer(uv);
    // Get ambient occlusion
    let ao = textureSample(gAO, samplerEnv, uv).r;

    // Calculate image based lighting
    let ibl = calculateIBL(g, ao);

    let final_color = vec4<f32>(ibl + g.selfIllum, 1.0);
    return final_color;
}