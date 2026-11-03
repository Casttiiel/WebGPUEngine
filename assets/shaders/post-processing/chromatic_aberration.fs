struct ChromaticAberrationParams {
    intensity:   f32, // 0-5, aberration strength
    startOffset: f32, // 0-1, fraction of screen radius where CA begins (0 = from center)
    _pad0:       f32,
    _pad1:       f32,
}

@group(0) @binding(0) var inputTex:     texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(1) @binding(0) var<uniform> params: ChromaticAberrationParams;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let color = textureSample(inputTex, inputSampler, uv);
    if params.intensity <= 0.0 {
        return color;
    }

    let center = vec2f(0.5);
    let dir    = uv - center;
    let dist   = length(dir);

    // Apply only beyond startOffset radius (like UE5's Start Offset)
    let t        = max(0.0, dist - params.startOffset * 0.5);
    let strength = t * t * params.intensity * 0.015;

    // Avoid division by zero at center
    let ndir = select(vec2f(0.0), normalize(dir), dist > 0.0005);

    // Separate R/G/B: red shifts inward, blue shifts outward
    let r = textureSample(inputTex, inputSampler, uv - ndir * strength).r;
    let g = textureSample(inputTex, inputSampler, uv).g;
    let b = textureSample(inputTex, inputSampler, uv + ndir * strength).b;

    return vec4f(r, g, b, color.a);
}
