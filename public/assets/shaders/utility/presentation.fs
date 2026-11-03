@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var gAlbedoSampler: sampler;

/** Interleaved gradient noise (Jimenez 2014) in [0, 1). */
fn ign(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>, @location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {
    let ldrColor = textureSample(gAlbedo, gAlbedoSampler, uv);

    let gammaCorrected = pow(ldrColor.rgb, vec3<f32>(1.0 / 2.2));

    // The swapchain is 8-bit: smooth gradients (vignette, sky, fog over flat ground) would band
    // into rings. Triangular dither of ±1 LSB, decorrelated per channel, hides the steps.
    let p = fragCoord.xy;
    let n1 = vec3<f32>(ign(p), ign(p + vec2<f32>(47.0, 17.0)), ign(p + vec2<f32>(91.0, 61.0)));
    let n2 = vec3<f32>(ign(p + vec2<f32>(13.0, 83.0)), ign(p + vec2<f32>(71.0, 29.0)), ign(p + vec2<f32>(37.0, 53.0)));
    let dithered = gammaCorrected + (n1 + n2 - 1.0) / 255.0;

    return vec4<f32>(dithered, 1.0);
}
