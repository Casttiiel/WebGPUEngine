#include "common/uniforms"

// ─── God Rays Composite ───────────────────────────────────────────────────────
//
// Step 4 of the screen-space god rays pipeline.
//
// Additively blends the blurred light-shaft buffer (Step 3 Kawase output)
// onto the full-resolution HDR frame.  The pipeline uses ADDITIVE blending
// (ONE + ONE), so this shader only outputs the contribution to add:
//
//   output.rgb = sunColor × shafts
//   final.rgb  = hdr.rgb + sunColor × shafts       ← GPU blends in-place
//
// The sun color comes from the DirectionalLight uniform, keeping the tint
// consistent with scene lighting (day/night cycles, color editing, etc.).
//
// Bind-group layout
//   group(0)  CameraUniforms         (standard engine binding)
//   group(1)  Kawase output texture + sampler   (SingleTexture)
//   group(2)  GodRaysCompositeParams uniform    (GodRaysUniforms re-used)
//   group(3)  AutoExposureRead — adapted scene exposure f32 (read-only storage)

// ─── Composite params struct ─────────────────────────────────────────────────
// 4 × f32 = 16 bytes.
struct GodRaysCompositeParams {
    sunR:  f32,  // Sun / directional-light red   channel
    sunG:  f32,  // Sun / directional-light green channel
    sunB:  f32,  // Sun / directional-light blue  channel
    scale: f32,  // Extra composite multiplier (default 1.0)
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// God rays (Kawase output) at quarter resolution — bilinearly upscaled
@group(1) @binding(0) var kawaseTexture: texture_2d<f32>;
@group(1) @binding(1) var kawaseSampler: sampler;

// Composite params (reuses GodRaysUniforms layout — same buffer binding)
@group(2) @binding(0) var<uniform> params: GodRaysCompositeParams;

// Auto-exposure buffer — adapted exposure computed by AutoExposureComponent each frame
@group(3) @binding(0) var<storage, read> exposureData: array<f32>;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.scale <= 0.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample the god rays buffer; red channel carries the shaft intensity.
    // Bilinear upscale from ¼ resolution is handled by the sampler.
    let shafts = textureSampleLevel(kawaseTexture, kawaseSampler, uv, 0.0).r;

    let contribution = vec3<f32>(params.sunR, params.sunG, params.sunB) * shafts * params.scale * exposureData[0];

    // Alpha = 0 — additive blend ignores dst alpha, only src RGB matters.
    return vec4<f32>(contribution, 0.0);
}
