#include "common/uniforms"

// ─── God Rays Radial Blur (Crytek Light Shafts) ───────────────────────────────
//
// Step 2 of the screen-space god rays pipeline.
//
// For each quarter-resolution pixel, marches 64 samples along the vector
// from the current UV toward the sun's UV (derived from NDC position).
// Each sample reads from the occlusion mask produced in Step 1 and is
// multiplied by an exponentially decaying illumination term.
//
// Result: a soft, directional light-shaft buffer at quarter resolution.
//
// Bind-group layout
//   group(0)  CameraUniforms              (camera.screenSize used for aspect)
//   group(1)  Occlusion mask + sampler    (SingleTexture — output of Step 1)
//   group(2)  GodRaysParams uniform       (GodRaysUniforms)

// ─── Uniform struct ───────────────────────────────────────────────────────────
struct GodRaysParams {
    sunNdcX:            f32,  // sun X in NDC [-1, 1]
    sunNdcY:            f32,  // sun Y in NDC [-1, 1]
    occlusionThreshold: f32,  // (unused here, kept for uniform parity)
    enabled:            f32,  // 0 = output black, 1 = compute shafts
    intensity:          f32,  // linear multiplier on the final result
    density:            f32,  // step-length factor (higher = wider march)
    decay:              f32,  // per-step illumination falloff < 1
    weight:             f32,  // per-sample contribution weight
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Occlusion mask from Step 1 (group 1 — SingleTexture layout)
@group(1) @binding(0) var maskTexture: texture_2d<f32>;
@group(1) @binding(1) var maskSampler: sampler;

// God rays params (group 2)
@group(2) @binding(0) var<uniform> params: GodRaysParams;

// ─── Constants ────────────────────────────────────────────────────────────────
const NUM_SAMPLES: i32 = 64;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Convert sun NDC to UV space.
    // WebGPU NDC: x ∈ [-1, 1] → u = x * 0.5 + 0.5
    //              y ∈ [-1, 1] → v = -y * 0.5 + 0.5  (y-down UVs)
    let sunUV = vec2<f32>(
        params.sunNdcX *  0.5 + 0.5,
        params.sunNdcY * -0.5 + 0.5,
    );

    // Direction from current fragment toward the sun, scaled by density / numSamples.
    let delta = (sunUV - uv) * (params.density / f32(NUM_SAMPLES));

    var sampleUV          = uv;
    var illuminationDecay = 1.0;
    var accumulated       = 0.0;

    for (var i: i32 = 0; i < NUM_SAMPLES; i++) {
        sampleUV += delta;

        // Sample the occlusion mask; .r = 1 for sky/sun, 0 for occluders.
        let occluded = textureSampleLevel(maskTexture, maskSampler, sampleUV, 0.0).r;

        accumulated       += occluded * illuminationDecay * params.weight;
        illuminationDecay *= params.decay;
    }

    let shafts = accumulated * params.intensity;
    return vec4<f32>(shafts, shafts, shafts, 1.0);
}
