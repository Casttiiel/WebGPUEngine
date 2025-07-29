#include "common/uniforms"
#include "common/utils"

struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    bias: f32,
    aoStrength: f32,
    maxDistance: f32,
    occScale: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

// Uniform buffer para parámetros SSAO
@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;

fn noise2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    // === Parameters ===
    let r = 0.5;
    let bias = 0.1;
    let strength = 2.0;
    let sampleCount = 8u;
    let resolution = camera.screenSize;

    // === Fetch depth & normal ===
    let linearZ = textureSample(gLinearDepth, samplerGBuffer, uv).x;
    let normalData = textureSample(gNormals, samplerGBuffer, uv);
    let normal = normalize(decodeNormal(normalData.xyz));

    // === Early-out value (no AO) ===
    let skipAO = linearZ >= 1.0;

    // === Reconstruct view position ===
    let ndc = vec4f(uv * 2.0 - 1.0, linearZ * 2.0 - 1.0, 1.0);
    let viewPosH = camera.invProjection * ndc;
    let viewPos = viewPosH.xyz / viewPosH.w;

    let stepAngle = 6.283185 / f32(sampleCount);
    var occlusion = 0.0;

    // === Loop over directions ===
    for (var i = 0u; i < sampleCount; i++) {
        let angle = f32(i) * stepAngle;
        let dir = vec2<f32>(cos(angle), sin(angle));
        let sampleUv = clamp(uv + dir * (r / resolution), vec2(0.0), vec2(1.0));

        // Get sample depth
        let sampleDepth = textureSample(gLinearDepth, samplerGBuffer, sampleUv).x;
        let sampleDepthClamped = select(sampleDepth, 0.999, sampleDepth >= 1.0);

        // Reconstruct sample position
        let sampleNdc = vec4(sampleUv * 2.0 - 1.0, sampleDepth * 2.0 - 1.0, 1.0);
        let sampleViewH = camera.invProjection * sampleNdc;
        let sampleViewPos = sampleViewH.xyz / sampleViewH.w;

        // Compute AO contribution
        let diff = sampleViewPos - viewPos;
        let dist = length(diff);
        let NdotD = dot(normal, normalize(diff));
        let attenuation = max(0.0, NdotD - bias);
        occlusion += attenuation / (1.0 + dist * dist);
    }

    var ao = pow(1.0 - occlusion / f32(sampleCount), strength);
    ao = select(ao, 1.0, skipAO);
    return ao;
}
