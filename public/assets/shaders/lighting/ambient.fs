#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"

struct AmbientUniforms {
    globalAmbientBoost: f32,
    diffuseBoost:       f32,
    isBaking:           f32,  // 1.0 during probe bake — uses white irradiance to avoid feedback
    probeBlendWeight:   f32,
    hasProbeA:          f32,  // 1.0 = SH coefficients are ready; 0.0 = no diffuse IBL
}

struct SHProbeUniforms {
    coefA: array<vec4<f32>, 9>,  // probe A: 9 × (R, G, B, pad) = 144 bytes
    coefB: array<vec4<f32>, 9>,  // probe B: 9 × (R, G, B, pad) = 144 bytes
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
@group(2) @binding(4) var<uniform> sh:      SHProbeUniforms;

// Evaluates SH L2 irradiance at direction N.
// Coefficients are stored with the cosine-lobe convolution factors pre-baked:
//   E(N) = Σ_k coef_k · Y_k(N)
fn evalSH(c: array<vec4<f32>, 9>, N: vec3<f32>) -> vec3<f32> {
    let x = N.x; let y = N.y; let z = N.z;
    var r = c[0].rgb * 0.282095;
    r += c[1].rgb * (0.488603 * y);
    r += c[2].rgb * (0.488603 * z);
    r += c[3].rgb * (0.488603 * x);
    r += c[4].rgb * (1.092548 * x * y);
    r += c[5].rgb * (1.092548 * y * z);
    r += c[6].rgb * (0.315392 * (3.0 * z * z - 1.0));
    r += c[7].rgb * (1.092548 * x * z);
    r += c[8].rgb * (0.546274 * (x * x - y * y));
    return max(r, vec3<f32>(0.0));
}

fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N   = normalize(g.normal);
    let V   = normalize(g.viewDir);
    let NdV = clamp(dot(N, V), 0.001, 1.0);

    var irradiance: vec3<f32>;
    if (ambient.isBaking > 0.5) {
        irradiance = vec3<f32>(1.0);
    } else if (ambient.hasProbeA > 0.5) {
        let irrA = evalSH(sh.coefA, N);
        let irrB = evalSH(sh.coefB, N);
        irradiance = mix(irrA, irrB, ambient.probeBlendWeight);
    } else {
        // Hemisphere ambient fallback when no probe is active.
        // Sky colour overhead, darker ground colour below — gives soft directional
        // ambient without needing any baked data.
        let hemi = dot(N, vec3<f32>(0.0, 1.0, 0.0)) * 0.5 + 0.5; // 0=ground, 1=sky
        let skyColour    = vec3<f32>(0.38, 0.50, 0.65);
        let groundColour = vec3<f32>(0.10, 0.07, 0.04);
        irradiance = mix(groundColour, skyColour, hemi);
    }

    // Use LUT-integrated directional albedo for kD — keeps energy conservation
    // consistent with the Kulla-Conty split-sum in the specular pass.
    let brdfCoords = vec2<f32>(clamp(NdV, 0.0, 1.0), 1.0 - clamp(g.roughness, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, samplerAO, brdfCoords, 0.0).rg;
    let E    = g.specularColor * brdf.x + brdf.y;
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = g.specularColor + (1.0 - g.specularColor) / 21.0;
    let Fms  = Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
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
