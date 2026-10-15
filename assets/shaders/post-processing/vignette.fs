struct VignetteParams {
    intensity:  f32, // 0-1, vignette darkness (0 = off, 1 = fully black corners)
    smoothness: f32, // 0-1, edge softness / gradient size
    _pad0:      f32,
    _pad1:      f32,
}

@group(0) @binding(0) var inputTex:     texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(1) @binding(0) var<uniform> params: VignetteParams;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let color = textureSample(inputTex, inputSampler, uv);
    if params.intensity <= 0.0 {
        return color;
    }

    // Remap UV to [-1, 1]
    let c = uv * 2.0 - 1.0;

    // Squared distance from center (0 at center, 2 at corners)
    let dist = dot(c, c);

    // Compute vignette: saturate so it never goes negative
    let vignette = saturate(1.0 - dist * params.intensity * 0.85);

    // Apply smoothness as gamma — higher smoothness = softer falloff
    let v = pow(vignette, 1.0 + params.smoothness * 2.0);

    return vec4f(color.rgb * v, color.a);
}
