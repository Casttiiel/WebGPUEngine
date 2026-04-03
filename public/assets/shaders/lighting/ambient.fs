#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/pcc"

struct AmbientUniforms {
    globalAmbientBoost: f32,
    diffuseBoost:       f32,
    isBaking:           f32,  // 1.0 during probe bake — skips irradiance to avoid feedback
    probeBlendWeight:   f32,
    // Probe A PCC data — xyz = world position, w = hasProbe (1.0 or 0.0)
    probeAPos: vec4<f32>,
    probeAMin: vec4<f32>,
    probeAMax: vec4<f32>,
    // Probe B PCC data
    probeBPos: vec4<f32>,
    probeBMin: vec4<f32>,
    probeBMax: vec4<f32>,
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
@group(2) @binding(6) var irradianceMapB:   texture_cube<f32>;


fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NdV = max(dot(N, V), 0.0);

    // Parallax-correct irradiance sampling directions for indoor probes only.
    // probeXPos.w encoding: 0=no probe, 1=outdoor(no PCC), 2=indoor(PCC)
    let irradDirA = select(
        N,
        parallaxCorrectDir(g.worldPos, N, ambient.probeAPos.xyz,
                           ambient.probeAMin.xyz, ambient.probeAMax.xyz),
        ambient.probeAPos.w > 1.5,  // only apply PCC for indoor probes
    );
    let irradDirB = select(
        N,
        parallaxCorrectDir(g.worldPos, N, ambient.probeBPos.xyz,
                           ambient.probeBMin.xyz, ambient.probeBMax.xyz),
        ambient.probeBPos.w > 1.5,
    );

    let irradianceA = textureSample(irradianceMap, samplerIrradiance, irradDirA).rgb;
    let irradianceB = textureSample(irradianceMapB, samplerIrradiance, irradDirB).rgb;
    let sampledIrradiance = mix(irradianceA, irradianceB, ambient.probeBlendWeight);
    // During probe baking use white irradiance to avoid feedback darkening
    let irradiance = select(sampledIrradiance, vec3<f32>(1.0), ambient.isBaking > 0.5);

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