// ---------------------------------------------------------------------------
// Shared helpers for the stochastic SSR passes (ssr.cs, ssr_temporal.cs, ssr_denoise.cs).
// Ports of three.js SpecularHelpers.js / RNoise.js / PostProcessingUtils, adapted to
// this engine's G-buffer:
//   gLinearDepth.x = distance along cameraFront / cameraFar  →  viewZ = -depth * far
//   gNormals       = (octahedral01 world normal .xy, roughness .z, emissive .w)
//   gAlbedo        = (albedo .rgb, metallic .a)
// View space is right-handed (-Z forward); UV v = 0 is the top of the screen.
// ---------------------------------------------------------------------------

// Rays that miss the screen report this "ray length" (three.js ENV_RAY_LENGTH).
const ENV_RAY_LENGTH: f32 = 1e4;
const ENV_RAY_LENGTH_THRESHOLD: f32 = 1e3;
const PI_SSR: f32 = 3.141592653589793;

struct SSRTraceParams {
    prevView:           mat4x4<f32>,
    prevProjection:     mat4x4<f32>,
    prevInvProjection:  mat4x4<f32>,
    prevInvView:        mat4x4<f32>,
    // SSR trace
    quality:            f32,
    mirrorBias:         f32,
    maxDistance:        f32,
    thickness:          f32,
    intensity:          f32,
    maxLuminance:       f32,
    screenEdgeFade:     f32,
    stepExponent:       f32,
    noiseIndex:         f32,
    cameraNear:         f32,
    envMaxMip:          f32,
    // Temporal reprojection
    maxFrames:          f32,
    clampIntensity:     f32,
    flickerSuppression: f32,
    hitPointReprojection: f32,
    historyValid:       f32,
    // Recurrent denoise
    lumaPhi:            f32,
    depthPhi:           f32,
    normalPhi:          f32,
    roughnessPhi:       f32,
    denoiseRadius:      f32,
    alphaPhi:           f32,
    strength:           f32,
    adapt:              f32,
    smoothDisocclusions: f32,
    adaptiveTrust:      f32,
    // Multi-bounce (previous denoised result folded in at the hit point)
    multiBounce:        f32,
    specularBoost:      f32,
    environmentIntensity: f32, // scale of the environment on misses (as the IBL)
    _pad0:              f32,
    _pad1:              f32,
    _pad2:              f32,
}

fn ssrLuminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Nearest texel of a full-resolution G-buffer texture at a UV (never filter across edges).
fn ssrGBufferCoord(tex: texture_2d<f32>, uv: vec2<f32>) -> vec2<i32> {
    let dims = vec2<i32>(textureDimensions(tex));
    return clamp(vec2<i32>(floor(uv * vec2<f32>(dims))), vec2<i32>(0), dims - vec2<i32>(1));
}

fn ssrSampleDepth(uv: vec2<f32>) -> f32 {
    return textureLoad(gLinearDepth, ssrGBufferCoord(gLinearDepth, uv), 0).x;
}

// View-space position from UV + linear depth, for any (inverse) projection.
fn ssrViewPositionWith(uv: vec2<f32>, linearDepth: f32, invProjection: mat4x4<f32>) -> vec3<f32> {
    let ndc  = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let rayH = invProjection * vec4<f32>(ndc, 0.5, 1.0);
    let ray  = rayH.xyz / rayH.w;
    return ray * ((-linearDepth * camera.cameraFar) / ray.z);
}

fn ssrViewPosition(uv: vec2<f32>, linearDepth: f32) -> vec3<f32> {
    return ssrViewPositionWith(uv, linearDepth, camera.invProjection);
}

fn ssrScreenFromClip(clip: vec4<f32>) -> vec2<f32> {
    let s = clip.xy / clip.w * 0.5 + 0.5;
    return vec2<f32>(s.x, 1.0 - s.y);
}

// World position → previous-frame UV (-1 when behind the camera).
fn ssrProjectToPrevUV(worldPos: vec3<f32>) -> vec2<f32> {
    let clip = params.prevProjection * (params.prevView * vec4<f32>(worldPos, 1.0));
    if (abs(clip.w) <= 1e-5) { return vec2<f32>(-1.0); }
    return ssrScreenFromClip(clip);
}

fn ssrUvInside(uv: vec2<f32>) -> bool {
    return all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
}

// three.js bindAnalyticNoise: R4 low-discrepancy sequence over a 32×32 tile,
// scrolled by a per-frame index.
fn ssrAnalyticNoise(pixel: vec2<f32>, sampleIndex: i32, seed: f32) -> vec4<f32> {
    let P = 1.32471795724474602596;
    let index  = f32(sampleIndex + i32(seed));
    let offset = floor(fract(vec2<f32>(index * 0.7548776662, index * 0.5698402910)) * 32.0);
    let coords = (floor(pixel) + offset) % vec2<f32>(32.0);
    let t = coords.x * (1.0 / P) + coords.y * (1.0 / (P * P)) + seed;
    return vec4<f32>(
        fract(t * P * (1.0 / P)),
        fract(t * (P * 2.0) * (1.0 / (P * P))),
        fract(t * (P * 3.0) * 0.4198754210),
        fract(t * (P * 4.0) * (1.0 / (P * P * P))),
    );
}

// Bounded-VNDF sampler (Eto & Tokuyoshi 2023; spherical-cap form, Dupuy & Benyoub 2023)
fn ssrSampleGGXVNDF(V: vec3<f32>, a: f32, r1: f32, r2: f32) -> vec3<f32> {
    let wiStd = normalize(vec3<f32>(a * V.x, a * V.y, V.z));
    let s  = 1.0 + length(V.xy);
    let a2 = a * a;
    let s2 = s * s;
    let k  = (1.0 - a2) * s2 / (s2 + a2 * V.z * V.z);
    let b  = wiStd.z * k;
    let phi = 6.283185307179586 * r1;
    let z   = (1.0 - r2) * (1.0 + b) - b;
    let sinTheta = sqrt(max(0.0, 1.0 - z * z));
    let c = vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), z);
    let wmStd = c + wiStd;
    return normalize(vec3<f32>(a * wmStd.x, a * wmStd.y, max(0.0, wmStd.z)));
}

// GGX reflection direction (view space) for surface normal N and view vector V (surface→camera).
fn ssrGGXReflectionDir(N: vec3<f32>, V: vec3<f32>, roughness: f32, Xi: vec4<f32>) -> vec3<f32> {
    let a = max(roughness * roughness, 0.001);
    var T = cross(vec3<f32>(0.0, 0.0, 1.0), N);
    if (length(T) < 1e-3) {
        T = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    }
    T = normalize(T);
    let B = normalize(cross(N, T));
    let Vlocal = vec3<f32>(dot(T, V), dot(B, V), dot(N, V));
    var Hlocal = ssrSampleGGXVNDF(Vlocal, a, Xi.x, Xi.y);
    if (Hlocal.z < 0.0) { Hlocal = -Hlocal; }
    let h = normalize(T * Hlocal.x + B * Hlocal.y + N * Hlocal.z);
    return normalize(reflect(-V, h));
}

// Specular dominant direction factor (Frostbite / REBLUR).
fn ssrSpecularDominantFactor(NoV: f32, roughness: f32) -> f32 {
    let a = 0.298475 * log(39.4115 - 39.0029 * roughness);
    let f = pow(1.0 - NoV, 10.8649) * (1.0 - a) + a;
    return clamp(f, 0.0, 1.0);
}

// Screen-edge fade (two smoothsteps for a soft ease-in-out).
fn ssrScreenBorderFactor(uv: vec2<f32>, borderWidth: f32) -> f32 {
    let border   = max(borderWidth, 1e-4);
    let edgeDist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let t = smoothstep(0.0, border, edgeDist);
    return pow(smoothstep(0.0, 1.0, t), 0.125);
}
