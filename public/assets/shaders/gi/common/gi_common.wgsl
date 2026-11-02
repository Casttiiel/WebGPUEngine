// ─── Realtime GI: shared parameters, probe-volume layout ──────────────────────
//
// Probe volumes (DDGI-style, RealtimeGI.ts / GIProbeVolumes.ts), listed in giVolumes, finest
// first: local volumes (gi_volume components: interiors), then either one volume fitted to the
// level or camera-centred cascades (spacing doubling). Each volume has its own dims and spacing
// and owns probes [dims.w, dims.w + dims.x·y·z) of the global probe arrays and atlases.
// Storage is toroidal: the probe at absolute grid coordinate `coord` lives in slot
// posMod(coord, dims), so when a cascade scrolls only the slots that wrap change meaning. Each
// slot remembers which coordinate it holds (giProbeState); a probe whose stored coordinate
// differs from the expected one is treated as missing until it is traced again. Each frame
// traces one batch of one volume (updateInfo).
//
// Per probe, in two atlases (one tile per probe, row-major by global probe index, 1-texel
// octahedral border for bilinear):
//   irradiance  GI_IRR_RES² rgba16float  rgb = irradiance E (not divided by π)
//   visibility  GI_VIS_RES² rgba16float  rg  = mean distance, mean squared distance (Chebyshev)
//
// Includers declare, with their own group/binding:
//   var<uniform> giParams: GIParams;
// Volume layout helpers (gi/common/gi_volumes) also need giVolumes, probe-state helpers
// (gi/common/gi_state) giProbeState, sampling (gi/common/gi_sampling) the atlases and a
// linear sampler.

struct GIParams {
    frameInfo:   vec4<u32>,     // x = frame index, y = light count, z = debug view, w = flags (GI_FLAG_*)
    gridInfo:    vec4<u32>,     // x = atlas tiles per row, y = volume count, z = rays per probe, w = volume traced this frame
    updateInfo:  vec4<u32>,     // x = first slot traced this frame, y = slots traced
    rayRotation: mat4x4<f32>,   // random rotation of this frame's ray set
    sunDir:      vec4<f32>,     // xyz = toward the sun, w = 1 if there is one
    sunColor:    vec4<f32>,     // rgb = colour × intensity
    tuning:      vec4<f32>,     // x = hysteresis (this frame's volume), y = sky intensity, z = GI intensity, w = compare split (uv.x)
    tuning2:     vec4<f32>,     // x = normal bias, y = view bias (× spacing), z = ray length, w = bounce strength
    atlasSize:   vec4<f32>,     // xy = irradiance atlas texels, zw = visibility atlas texels
    ambient:     vec4<f32>,     // x = global ambient boost, y = diffuse boost (ambient.fs probe path)
}

struct GIVolume {
    origin:  vec4<i32>,   // xyz = absolute grid coordinate of the min probe
    dims:    vec4<u32>,   // xyz = probes per axis, w = first global probe index
    spacing: vec4<f32>,   // x = metres between probes, y = fade width (cells) at the edges, z = kind (0 local, 1 level, 2 cascade)
}

struct GILight {
    posRadius:    vec4<f32>,  // xyz = position, w = outer radius
    colorFalloff: vec4<f32>,  // rgb = colour × intensity, w = start falloff radius
    dirCos:       vec4<f32>,  // xyz = spot forward, w = cos(half angle); w < -1 for point lights
}

const GI_IRR_RES: u32 = 6u;
const GI_VIS_RES: u32 = 14u;
/** A probe whose (smoothed) share of back-face hits exceeds this is inside geometry: skipped. */
const GI_INACTIVE_RATIO: f32 = 0.25;
const GI_FLAG_MULTIBOUNCE: u32 = 1u;
const GI_FLAG_COMPARE: u32 = 2u;
const GI_PI: f32 = 3.14159265359;
const GI_INV_PI: f32 = 0.31830988618;
/** Ray distance written for misses (sky). */
const GI_MISS_DISTANCE: f32 = 1.0e4;

// ── Octahedral mapping ([-1,1]² ↔ unit sphere) ───────────────────────────────

fn giSignNotZero(v: vec2<f32>) -> vec2<f32> {
    return select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
}

fn giOctEncode(n: vec3<f32>) -> vec2<f32> {
    let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    return select(p, (1.0 - abs(p.yx)) * giSignNotZero(p), n.z < 0.0);
}

fn giOctDecode(e: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
    if (n.z < 0.0) {
        n = vec3<f32>((1.0 - abs(n.yx)) * giSignNotZero(n.xy), n.z);
    }
    return normalize(n);
}

// ── Random numbers / ray set ─────────────────────────────────────────────────

fn giHash(x: u32) -> u32 {
    var h = x;
    h ^= h >> 16u; h *= 0x7feb352du;
    h ^= h >> 15u; h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}

fn giRand(state: ptr<function, u32>) -> f32 {
    *state = giHash(*state);
    return f32(*state >> 8u) * (1.0 / 16777216.0);
}

fn giSphericalFibonacci(i: u32, n: u32) -> vec3<f32> {
    let phi = 2.0 * GI_PI * fract(f32(i) * 0.6180339887498949);
    let cosTheta = 1.0 - (2.0 * f32(i) + 1.0) / f32(n);
    let sinTheta = sqrt(saturate(1.0 - cosTheta * cosTheta));
    return vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}

/** Direction of probe ray `i` this frame (all probes share the rotated set). */
fn giRayDirection(i: u32) -> vec3<f32> {
    let d = giSphericalFibonacci(i, giParams.gridInfo.z);
    return normalize((giParams.rayRotation * vec4<f32>(d, 0.0)).xyz);
}
