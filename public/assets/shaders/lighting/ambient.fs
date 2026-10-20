#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"

#include "common/probes"

struct AmbientUniforms {
    globalAmbientBoost: f32,
    diffuseBoost:       f32,
    _pad0:              f32,
    _pad1:              f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var gAO:              texture_2d<f32>;
@group(2) @binding(1) var samplerAO:        sampler;
@group(2) @binding(2) var<uniform> ambient: AmbientUniforms;
@group(2) @binding(3) var brdfLUT:          texture_2d<f32>;
@group(2) @binding(4) var<storage, read> probeSet: ProbeSet;

fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NdV = clamp(dot(N, V), 0.001, 1.0);

    // Per pixel: the probes whose box holds this point, the sky SH for the rest.
    let probes = probeIrradiance(g.worldPos, N);
    var irradiance = probes.irradiance;
    if (probes.coverage < 1.0) {
        // Nothing loaded yet: hemisphere ambient (sky above, ground below) so the
        // first frames aren't black.
        let hemi = dot(N, vec3<f32>(0.0, 1.0, 0.0)) * 0.5 + 0.5;
        let skyColour    = vec3<f32>(0.38, 0.50, 0.65);
        let groundColour = vec3<f32>(0.10, 0.07, 0.04);
        irradiance += mix(groundColour, skyColour, hemi) * (1.0 - probes.coverage);
    }

    // Use LUT-integrated directional albedo for kD — keeps energy conservation
    // consistent with the Kulla-Conty split-sum in the specular pass.
    let brdfCoords = vec2<f32>(clamp(NdV, 0.0, 1.0), 1.0 - clamp(g.roughness, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, samplerAO, brdfCoords, 0.0).rg;
    let E    = g.specularColor * brdf.x + brdf.y;
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = g.specularColor + (1.0 - g.specularColor) / 21.0;
    let Fms  = E * Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let kD   = (1.0 - E - Fms) * (1.0 - g.metallic);

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
