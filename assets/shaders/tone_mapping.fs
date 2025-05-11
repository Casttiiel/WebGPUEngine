@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

fn Uncharted2Tonemap(x: vec3<f32>) -> vec3<f32> {
    let A: f32 = 0.15;
    let B: f32 = 0.50;
    let C: f32 = 0.10;
    let D: f32 = 0.20;
    let E: f32 = 0.02;
    let F: f32 = 0.30;

    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - (E / F);
}

fn toneMappingUncharted2(x: vec3<f32>) -> vec3<f32> {
    let ExposureBias: f32 = 2.0;
    let W: f32 = 11.2;

    let curr = Uncharted2Tonemap(ExposureBias * x);
    let whiteScale = vec3<f32>(1.0) / Uncharted2Tonemap(vec3<f32>(W));

    return curr * whiteScale;
}

@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let GlobalExposureAdjustment: f32 = 1.0; // TODO DEBERIA SER UNA UNIFORM
    var hdrColor = textureSample(gAlbedo, gAlbedoSampler, uv);
    hdrColor = hdrColor * GlobalExposureAdjustment;

    let tmColorUC2 = toneMappingUncharted2(hdrColor.xyz);
    return vec4<f32>(tmColorUC2, 1.0);
}