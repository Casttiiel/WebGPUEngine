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

@group(2) @binding(0) var gAO:            texture_2d<f32>;
@group(2) @binding(1) var samplerAO:       sampler;
@group(2) @binding(2) var<uniform> ambient: AmbientUniforms;
@group(2) @binding(3) var irradianceMap:    texture_cube<f32>;
@group(2) @binding(4) var samplerIrradiance: sampler;
@group(2) @binding(5) var brdfLUT:         texture_2d<f32>;


fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NdV = max(dot(N, V), 0.0);

    let irradianceDir = N;
    let irradiance = textureSample(irradianceMap, samplerIrradiance, irradianceDir).rgb;

    // Use LUT-integrated directional albedo E = brdf.x + brdf.y for kD so that
    // energy conservation is consistent with the Kulla-Conty splitSum in the specular pass.
    // Point-Fresnel F would under-subtract from kD compared to the hemisphere-integrated F.
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdV, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, samplerAO, brdfCoords, 0.0).rg;
    let E  = brdf.x + brdf.y; // hemisphere-integrated directional albedo
    let kD = (1.0 - E) * (1.0 - g.metallic);

    let diffuse = kD * Diffuse(g.albedo) * irradiance;

    return diffuse * ambient.diffuseBoost * ambient.globalAmbientBoost * ao;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    if (g.zlinear > 0.999) { discard; }

    let aoSample = textureSample(gAO, samplerAO, uv);
    let ao = aoSample.b;  // AO scalar packed in .b

    let ibl = calculateIBL(g, ao);

    return vec4<f32>(ibl + g.selfIllum, 1.0);
}