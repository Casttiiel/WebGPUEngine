#include "common/uniforms"
#include "common/structs"

// Alpha test for the shadow map: same 0.5 cutoff as gbuffer_mask.fs so cut-out
// geometry casts the shadow of what is actually drawn, not of its whole quad.

@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@fragment
fn fs(@location(0) uv: vec2<f32>) {
    let alpha = textureSampleLevel(txAlbedo, samplerState, uv * vec2<f32>(factors.uvXScale, factors.uvYScale), 0.0).a;
    if (alpha < 0.5) {
        discard;
    }
}
