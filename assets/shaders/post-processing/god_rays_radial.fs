struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}


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
// 12 × f32 = 48 bytes (matches occlusion pass — same buffer).
struct GodRaysParams {
    sunNdcX:            f32,  // sun X in NDC [-1, 1]
    sunNdcY:            f32,  // sun Y in NDC [-1, 1]
    occlusionThreshold: f32,  // (unused here, kept for uniform parity)
    enabled:            f32,  // 0 = output black, 1 = compute shafts
    intensity:          f32,  // linear multiplier on the final result
    density:            f32,  // step-length factor (higher = wider march)
    decay:              f32,  // per-step illumination falloff < 1
    weight:             f32,  // per-sample contribution weight
    nearCutoff:         f32,  // (unused here — used by occlusion pass)
    sunFalloff:         f32,  // (unused here — used by occlusion pass)
    _pad1:              f32,
    _pad2:              f32,
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
