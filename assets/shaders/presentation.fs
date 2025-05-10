@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let ldrColor = textureSample(gAlbedo, gAlbedoSampler, uv);

    let gammaCorrected = pow(abs(ldrColor.rgb), vec3<f32>(1.0 / 2.2));

    return vec4<f32>(gammaCorrected, 1.0);
}