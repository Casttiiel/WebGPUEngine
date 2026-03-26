#include "common/uniforms"
#include "common/structs"

@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

// Depth-only alpha-test pass.
// Discards fragments whose alpha is below 0.5 so the depth buffer
// only receives depth for actually opaque regions of masked geometry.
// No color output — depth is written by the fixed-function depth test.
@fragment
fn fs(input: VertexOutput) {
    let uv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    let alpha = textureSample(txAlbedo, samplerState, uv).a;
    if (alpha < 0.5) { discard; }
}
