@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

// Auto Exposure — written by AutoExposureComponent compute pass each frame
@group(1) @binding(0) var<storage, read> exposureData: array<f32>;

fn tonemapACES(color: vec3<f32>) -> vec3<f32> {
    // ACES approximation by Krzysztof Narkowicz
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;

    return clamp((color * (a * color + vec3(b))) / (color * (c * color + vec3(d)) + vec3(e)), vec3(0.0), vec3(1.0));
}

@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let adaptedExposure = exposureData[0];
    var hdrColor = textureSample(gAlbedo, gAlbedoSampler, uv).rgb;
    hdrColor *= adaptedExposure;

    hdrColor = tonemapACES(hdrColor);

    return vec4<f32>(hdrColor, 1.0);
}