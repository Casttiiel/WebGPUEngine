// Weighted Blended OIT — Compose Pass
// Resolves the accumulation + revealage targets from the gather pass
// and composites the result over the opaque accLight buffer.
//
// Blend state on the technique must be PREMULTIPLIED (ONE + ONE_MINUS_SRC_ALPHA)
// so the output blends correctly over the existing accLight content.

@group(0) @binding(0) var txAccumulation: texture_2d<f32>;
@group(0) @binding(1) var txRevealage:    texture_2d<f32>;
@group(0) @binding(2) var samplerState:   sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let accum  = textureSample(txAccumulation, samplerState, uv);
    let reveal = textureSample(txRevealage,    samplerState, uv).r;

    // Skip pixels with no transparent contribution
    if (abs(accum.a) < 1e-4) { discard; }

    // Reconstruct weighted-average color
    let avgColor = accum.rgb / max(accum.a, 1e-5);

    // reveal holds product(1 - alpha_i), so 1 - reveal = total alpha
    let alpha = 1.0 - reveal;

    // Premultiplied output — composites over accLight via ONE + ONE_MINUS_SRC_ALPHA
    return vec4<f32>(avgColor * alpha, alpha);
}
