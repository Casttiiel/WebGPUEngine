@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

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
    let adaptedExposure = 1.0; // TODO DEBERIA SER UNA UNIFORM
    var hdrColor = textureSample(gAlbedo, gAlbedoSampler, uv).rgb;
    hdrColor *= adaptedExposure;

    hdrColor = tonemapACES(hdrColor);

    return vec4<f32>(hdrColor, 1.0);
}