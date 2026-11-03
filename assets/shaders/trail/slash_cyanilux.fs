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
    // Scene sun (offset 116 = byte 464): xyz = direction toward the sun, w = 1 if present.
    sunDirection: vec4<f32>,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}


// ── Cyanilux sword slash — adapted for ribbon trail UVs ─────────────────────
//
// Textures (set via material JSON):
//   txAlbedo  (binding 0) — triangle/wedge slash mask  (bright centre, dark edges)
//   txNormal  (binding 1) — seamless tiling noise
//
// UV convention (from TrailRendererComponent):
//   uv.x = 0 (tip/posA) → 1 (hilt/posB)    across the blade
//   uv.y = 0 (newest)   → 1 (oldest/tail)   along the arc
//
// The Cyanilux "Slash" pan maps to our uv.y: the trail geometry already
// handles the reveal (nodes age out), so we sample the texture directly.

@group(0) @binding(0) var<uniform> camera:    CameraUniforms;
@group(1) @binding(0) var txSlash:   texture_2d<f32>;   // slash shape mask
@group(1) @binding(1) var txNoise:   texture_2d<f32>;   // seamless noise
@group(1) @binding(5) var txSampler: sampler;

// ── Tunable constants ────────────────────────────────────────────────────────
const INTENSITY:   f32        = 22.0;
const STEP_A:      f32        = 0.0;
const STEP_B:      f32        = 0.08;
const NOISE_SPEED: f32        = 2.2;
const NOISE_TILE:  vec2<f32>  = vec2<f32>(2.5, 2.5);
// Edge scale: higher = tighter mask (more of the quad corners are cut off).
// Cyanilux uses (2.7, 2.0) on a centred UV; we clamp Y to tail-only fade.
const EDGE_SCALE_X: f32 = 2.6;
// ─────────────────────────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,
    @location(1) color: vec4<f32>,
) -> @location(0) vec4<f32> {

    // ── Slash mask texture ────────────────────────────────────────────────
    // Swap axes: our uv.x is the "depth" (across blade) and uv.y the "arc".
    // Sampling with (uv.y, uv.x) maps a horizontal slash shape onto the arc.
    let slashUV    = vec2<f32>(uv.y, uv.x);
    let slashSample = textureSample(txSlash, txSampler, slashUV).r;

    // ── Edge fade mask (Cyanilux core formula) ────────────────────────────
    // abs(UV − 0.5) × scale → one_minus → saturate → multiply R × G
    let edgeX = saturate(1.0 - abs(uv.x * 2.0 - 1.0) * EDGE_SCALE_X);  // blade edge fade
    let edgeY = saturate(1.0 - uv.y * 1.05);                             // tail fade (not centred)
    let edgeMask = edgeX * edgeY;

    // ── Noise texture (scrolling along arc) ──────────────────────────────
    let noiseUV     = fract(uv * NOISE_TILE + vec2<f32>(-camera.time * NOISE_SPEED, 0.0));
    let noiseSample = textureSample(txNoise, txSampler, noiseUV).r;

    // ── Combine (Cyanilux node graph) ────────────────────────────────────
    // slashMask × edgeMask × noise × intensity → smoothstep → lerp A↔B
    let combined = slashSample * edgeMask * noiseSample * INTENSITY;
    let alpha    = smoothstep(STEP_A, STEP_B, combined);

    // Color A = CPU startColor tint (head) → endColor (tail)
    // Color B = white (bright core at peak intensity)
    let col = mix(color.rgb, vec3<f32>(1.0), alpha);

    return vec4<f32>(col, alpha * color.a);
}
