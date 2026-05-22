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


// ─── God Rays Kawase Blur ─────────────────────────────────────────────────────
//
// Step 3 of the screen-space god rays pipeline.
//
// Classic Kawase blur: 4 diagonal taps at (±0.5 + offset) × texelSize.
// Run 5 times in ping-pong with offsets 0, 1, 2, 2, 3 to smooth the
// banding artefacts produced by the 64-sample radial march in Step 2.
//
// texelSize is computed from the actual texture dimensions — no extra
// uniform needed.
//
// Bind-group layout
//   group(0)  CameraUniforms              (standard engine binding)
//   group(1)  Ping-pong input + sampler   (SingleTexture)
//   group(2)  KawaseParams uniform        (KawaseUniforms)

// ─── Uniform struct ───────────────────────────────────────────────────────────
// 16 bytes — 4 × f32 for WebGPU uniform buffer alignment.
struct KawaseParams {
    offset: f32,   // Kawase step offset k (pre-written per-pass buffer)
    _pad0:  f32,
    _pad1:  f32,
    _pad2:  f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Ping-pong input (group 1 — SingleTexture layout)
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

// Kawase step params (group 2)
@group(2) @binding(0) var<uniform> params: KawaseParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let dims      = textureDimensions(inputTexture);
    let texelSize = vec2<f32>(1.0 / f32(dims.x), 1.0 / f32(dims.y));

    // Half-pixel offset: (k + 0.5) × texelSize
    let h = (params.offset + 0.5) * texelSize;

    let a = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>( h.x,  h.y), 0.0);
    let b = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>(-h.x,  h.y), 0.0);
    let c = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>( h.x, -h.y), 0.0);
    let d = textureSampleLevel(inputTexture, inputSampler, uv + vec2<f32>(-h.x, -h.y), 0.0);

    return (a + b + c + d) * 0.25;
}
