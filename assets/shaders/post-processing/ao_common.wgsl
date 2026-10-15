// ---------------------------------------------------------------------------
// Shared helpers for the AO compute passes (gtao.cs, ssao.cs, ao_blur.cs).
// Port of three.js PostProcessingUtils (getViewPosition, getScreenPositionFromClip,
// interleavedGradientNoise, vogelDiskSample) adapted to this engine's linear depth:
//   gLinearDepth = distance along cameraFront / cameraFar  →  viewZ = -depth * far
// View space is right-handed (gl-matrix lookAt): -Z forward, +Y up.
// UV space has v = 0 at the top of the screen, so Y is flipped to/from NDC.
// ---------------------------------------------------------------------------

struct AOParams {
    samples:           f32,
    radius:            f32,
    thickness:         f32, // GTAO
    scale:             f32, // GTAO: final pow exponent
    intensity:         f32, // SSAO
    bias:              f32, // SSAO
    blurSharpness:     f32, // depth-aware blur
    temporalDirection: f32, // GTAO: slice rotation (rotation° / 360, as three.js)
    temporalOffset:    f32, // GTAO: spatial jitter offset
    resolutionScale:   f32, // AO resolution / render resolution
    _pad0:             f32,
    _pad1:             f32,
}

// Linear depth [0,1] at a UV, nearest texel (depth must never be filtered across edges).
fn aoSampleDepth(uv: vec2<f32>) -> f32 {
    let dims  = vec2<i32>(textureDimensions(gLinearDepth));
    let coord = clamp(vec2<i32>(floor(uv * vec2<f32>(dims))), vec2<i32>(0), dims - vec2<i32>(1));
    return textureLoad(gLinearDepth, coord, 0).x;
}

// View-space position from UV + linear depth.
fn aoGetViewPosition(uv: vec2<f32>, linearDepth: f32) -> vec3<f32> {
    let ndc  = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let rayH = camera.invProjection * vec4<f32>(ndc, 0.5, 1.0);
    let ray  = rayH.xyz / rayH.w;
    let viewZ = -linearDepth * camera.cameraFar;
    return ray * (viewZ / ray.z);
}

fn aoGetScreenPositionFromClip(clip: vec4<f32>) -> vec2<f32> {
    let s = clip.xy / clip.w * 0.5 + 0.5;
    return vec2<f32>(s.x, 1.0 - s.y);
}

// World-space G-buffer normal → view space.
fn aoGetViewNormal(uv: vec2<f32>) -> vec3<f32> {
    let dims   = vec2<i32>(textureDimensions(gNormals));
    let coord  = clamp(vec2<i32>(floor(uv * vec2<f32>(dims))), vec2<i32>(0), dims - vec2<i32>(1));
    let nWorld = octahedral01ToNormal(textureLoad(gNormals, coord, 0).xy);
    return normalize((camera.viewMatrix * vec4<f32>(nWorld, 0.0)).xyz);
}

fn aoInterleavedGradientNoise(position: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(position, vec2<f32>(0.06711056, 0.00583715))));
}

fn aoRand(uv: vec2<f32>) -> f32 {
    let dt = dot(uv, vec2<f32>(12.9898, 78.233));
    // mod(dt, PI) with GLSL semantics (result has the sign of the divisor)
    let sn = dt - PI * floor(dt / PI);
    return fract(sin(sn) * 43758.5453);
}

fn aoVogelDiskSample(sampleIndex: i32, samplesCount: i32, phi: f32) -> vec2<f32> {
    let goldenAngle = 2.399963229728653;
    let r     = sqrt((f32(sampleIndex) + 0.5) / f32(samplesCount));
    let theta = f32(sampleIndex) * goldenAngle + phi;
    return vec2<f32>(cos(theta), sin(theta)) * r;
}

// Packing shared with the lighting shaders: AO scalar in .b, neutral bent normal in .rg.
fn aoPack(ao: f32) -> vec4<f32> {
    return vec4<f32>(0.5, 0.5, ao, 1.0);
}
