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

// ── Value noise (seamless via fract UVs — Godot trick) ───────────────────────

fn hash2(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash2(i),               hash2(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

// ── Fragment ─────────────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,   // x=0(tip)→1(hilt), y=0(head/newest)→1(tail/oldest)
    @location(1) color: vec4<f32>,   // cpu-lerped startColor→endColor
) -> @location(0) vec4<f32> {

    // ── Blade-centre distance (Cyanilux edge-mask base) ──────────────────
    let xDist = abs(uv.x - 0.5) * 2.0;   // 0 at centre, 1 at each edge

    // Taper the visible width toward the tail so the slash "closes" as it ages
    let taper  = mix(1.0, 0.12, uv.y * uv.y);
    let xNorm  = clamp(xDist / taper, 0.0, 1.6);

    // ── Noise dissolve on the edge (Godot) ───────────────────────────────
    // fract keeps the noise seamless — prevents ugly hard seams at UV=1
    let nUV   = fract(uv * vec2<f32>(3.5, 6.0)
                      + vec2<f32>(camera.time * 0.35, camera.time * 0.18));
    let noise = vnoise(nUV * 4.0) * 0.28;

    // Dissolve: noise offsets the smoothstep boundary so the edge looks organic
    let edgeMask = smoothstep(1.0 + noise, 0.52 + noise, xNorm);

    // ── Cyanilux: also mask the arc ends (prevents hard quad corners) ────
    // Multiply in the Y axis edge fade — soft at tail, sharp at head
    let arcMask  = smoothstep(0.0, 0.06, 1.0 - uv.y)   // soft at tail end
                 * smoothstep(0.0, 0.03, uv.y + 0.03);  // tiny ramp-in at head
    let fullMask = edgeMask * arcMask;

    // Hard core region — sharp bright centre line regardless of noise
    let coreMask = smoothstep(0.55, 0.0, xNorm);

    // ── Three-tone gradient (Godot) ───────────────────────────────────────
    // bright (white core) → mid (user tint) → dark (near-transparent edge)
    let gradT  = clamp(xNorm, 0.0, 1.0);
    let bright = vec3<f32>(1.0);
    let mid    = color.rgb;
    let dark   = color.rgb * 0.10;

    var col = mix(
        mix(bright, mid, smoothstep(0.0, 0.42, gradT)),
        dark,
        smoothstep(0.38, 1.0, gradT),
    );

    // ── Tail fade ─────────────────────────────────────────────────────────
    let tailFade = 1.0 - smoothstep(0.0, 1.0, uv.y);

    // ── Head burst: extra flash at the newest segment ─────────────────────
    let headBurst = exp(-uv.y * 8.0);
    col += bright * headBurst * 0.75 * coreMask;

    // ── Energy ripple travelling along the arc (Cyanilux panning) ─────────
    // Simulates the panning slash texture with a procedural sine wave instead
    let ripple = sin(uv.y * 14.0 - camera.time * 9.0) * 0.5 + 0.5;
    col += mid * ripple * 0.20 * coreMask * tailFade;

    // ── Flicker (Godot) ───────────────────────────────────────────────────
    let flicker = sin(camera.time * 22.0) * 0.06 + 1.0;
    col *= flicker;

    // ── Apply CPU tint (startColor → endColor lerp) ───────────────────────
    // Blends the whole output toward the user-defined colour so the slash
    // takes on the chosen palette while still keeping a bright white core.
    col *= mix(vec3<f32>(1.0), color.rgb, 0.65);

    // ── Alpha ─────────────────────────────────────────────────────────────
    let alpha = color.a * fullMask * tailFade;

    return vec4<f32>(col, alpha);
}
