#include "common/uniforms"
#include "common/structs"

// ── Dithered transparency depth prepass ──────────────────────────────────────
// Companion depth-only pass for gbuffer_dither.fs.
// Applies the same Bayer 4×4 threshold used in the GBuffer fill so the depth
// buffer matches exactly, enabling correct early-Z rejection in the main pass.
// No color output — depth written by the fixed-function depth test.

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

fn bayer4(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

@fragment
fn fs(input: VertexOutput) {
    let uv    = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    let alpha = textureSample(txAlbedo, samplerState, uv).a;
    let pixelCoord = vec2<u32>(input.position.xy);
    if (alpha <= bayer4(pixelCoord)) { discard; }
}
