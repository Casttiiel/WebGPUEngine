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


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Streaked slash (after Eduardo Braz's "Slash + Mini Tutorial"): a bright outer edge, the body
// made of fine streaks stretched along the motion, the trailing end frayed into streaks of
// different lengths, the inner side dissolving, and a color ramp dark → tint → white-hot (HDR,
// so bloom picks the core up). Fully procedural: the ribbon's UVs play the role of the arc mesh.

fn hash1(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash1(i), hash1(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash1(i + vec2<f32>(0.0, 1.0)), hash1(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,   // x = 0 (tip, outer edge) → 1 (hilt, inner), y = 0 (head) → 1 (tail)
    @location(1) color: vec4<f32>,   // cpu-lerped startColor → endColor along the trail
) -> @location(0) vec4<f32> {
    let x = clamp(uv.x, 0.0, 1.0);
    let y = clamp(uv.y, 0.0, 1.0);
    let t = camera.time;

    // ── Streaks: noise stretched along the motion (many lines across, long along) ──
    // They flow slightly toward the tail and break into dashes as they age.
    let flow = y * 2.2 - t * 1.5;
    let s1 = vnoise(vec2<f32>(x * 46.0, flow));
    let s2 = vnoise(vec2<f32>(x * 97.0 + 13.0, flow * 1.7 + 4.0));
    let streakNoise = s1 * 0.65 + s2 * 0.35;
    var streaks = smoothstep(mix(0.55, 0.7, y), mix(0.7, 0.88, y), streakNoise);
    // ...and break into dashes toward the tail
    let dash = vnoise(vec2<f32>(x * 46.0 + 5.0, y * 11.0 - t * 4.0));
    streaks *= mix(1.0, smoothstep(0.3, 0.6, dash), smoothstep(0.1, 0.6, y));

    // ── Frayed tail: each streak ends at its own length (Mask1) ──
    let fray = vnoise(vec2<f32>(x * 31.0, 7.3)) * 0.55 + vnoise(vec2<f32>(x * 73.0, 2.1)) * 0.25;
    let tailMask = 1.0 - smoothstep(0.15 + fray * 0.6, 0.45 + fray * 0.7, y);

    // ── Across: blazing outer rim, body fading toward the inner side, which dissolves ──
    let rim = exp(-x * 26.0);
    let body = pow(1.0 - x, 1.6);
    let innerCut = 1.0 - smoothstep(0.55 + fray * 0.25, 0.95, x);

    // ── Head: solid, brighter leading cap ──
    let head = exp(-y * 9.0);

    let shape = tailMask * innerCut * smoothstep(0.0, 0.02, y + 0.005);
    var intensity = shape * (body * (0.04 + 1.0 * streaks) + rim * (0.7 + 0.5 * streaks) + head * body * 0.4);
    intensity *= color.a;

    // ── Color ramp: deep tint → saturated tint → white-hot only at the strongest rim ──
    let tint = color.rgb;
    var col = mix(tint * 0.5, tint * 1.5, smoothstep(0.05, 0.5, intensity));
    col = mix(col, vec3<f32>(1.4) + tint * 0.8, smoothstep(0.9, 1.4, intensity) * 0.45);

    // Blend is additive by source alpha, so the color stays unpremultiplied
    let alpha = clamp(intensity, 0.0, 1.0);
    return vec4<f32>(col, alpha);
}
