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
