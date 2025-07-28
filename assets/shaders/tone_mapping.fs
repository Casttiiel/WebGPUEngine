@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let adaptedExposure = 0.18; // TODO DEBERIA SER UNA UNIFORM
    var hdrColor = textureSample(gAlbedo, gAlbedoSampler, uv).rgb;

    hdrColor *= adaptedExposure;

    // ===== AGX tonemapping core =====
    var luma = dot(hdrColor, vec3<f32>(0.2126, 0.7152, 0.0722));
    hdrColor = mix(vec3<f32>(luma), hdrColor, 0.95); // pre-desaturar highlights

    // Shoulder curve
    var a = 0.22;
    var b = 0.30;
    var c = 0.10;
    var d = 0.20;
    var e = 0.01;
    var f = 0.30;

    hdrColor = (hdrColor * (a * hdrColor + b)) / (hdrColor * (c * hdrColor + d) + e) + f;
    hdrColor /= ((a + b) / (c + d) + e) + f;

    return vec4<f32>(hdrColor, 1.0);
}