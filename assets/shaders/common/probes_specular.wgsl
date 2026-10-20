// Specular half of the probe system (common/probes.wgsl): includers also declare
//   var probeEnvArray: texture_cube_array<f32>;

// ─── Reflection / irradiance probes, per pixel ───────────────────────────────
//
// ProbeManager uploads the probes near the camera (ProbeSet) and keeps every probe's
// GGX-prefiltered cubemap in one cube array. Each pixel blends the probes whose box
// contains it, by a weight that fades `fade` metres either side of the box faces — so
// boxes that tile (auto-placement) cross-fade at their shared face and sum to 1 there.
// Where the weights add up to less than 1, the global environment fills the rest.
//
// Includers declare, with their own group/binding:
//   var<storage, read> probeSet: ProbeSet;
// Specular (cube array) helpers: common/probes_specular.wgsl.

// ─── Parallax Corrected Cubemap (PCC) ────────────────────────────────────────
//
// Standard cubemaps assume the environment is infinitely far away.
// PCC corrects the reflection/normal vector so it "points" to the right
// position inside the probe's AABB, aligning reflections with real room geometry.
//
// Algorithm (Lagarde & de Rousiers, "Physically Based Rendering in Call of Duty",
//            also used extensively in Uncharted 4 interiors):
//
//   1. For each axis, compute the intersection distance with the near and far
//      slab of the AABB: rbmax = (boxMax - P) / R,  rbmin = (boxMin - P) / R
//   2. Per-component, pick the exit slab:
//         if R > 0  →  exit is boxMax slab  (rbmax)
//         if R < 0  →  exit is boxMin slab  (rbmin)
//   3. The actual exit distance is min(rbminmax.xyz)
//   4. posonbox = P + R * fa   ← world-space hit point on the AABB surface
//   5. Return (posonbox - probePos) — direction from probe capture point to
//      that surface hit.  The cubemap was shot from probePos, so this direction
//      indexes the correct texel.
//
// worldPos  – fragment world-space position
// R         – ray direction to correct (should be normalised)
// probePos  – world-space capture/centre position of the probe
// boxMin    – world-space AABB minimum
// boxMax    – world-space AABB maximum
//
// Returns an unnormalised direction (GPU normalises cube samples implicitly).
fn parallaxCorrectDir(
    worldPos : vec3<f32>,
    R        : vec3<f32>,
    probePos : vec3<f32>,
    boxMin   : vec3<f32>,
    boxMax   : vec3<f32>,
) -> vec3<f32> {
    let rbmax    = (boxMax - worldPos) / R;
    let rbmin    = (boxMin - worldPos) / R;
    // Per-component: pick the exit-slab distance based on ray sign
    let rbminmax = select(rbmin, rbmax, R > vec3<f32>(0.0));
    // Smallest exit distance across all three axes
    let fa       = min(min(rbminmax.x, rbminmax.y), rbminmax.z);
    // World-space hit point → direction from probe capture origin
    let posonbox = worldPos + R * fa;
    return posonbox - probePos;
}


struct ProbeGPU {
    pos:    vec4<f32>,             // xyz = capture point, w = 1 outdoor / 2 indoor (PCC)
    boxMin: vec4<f32>,             // xyz = influence box min
    boxMax: vec4<f32>,             // xyz = influence box max, w = cube index (-1 = no env yet)
    fade:   vec4<f32>,             // xyz = cross-fade distance per axis (m)
    sh:     array<vec4<f32>, 9>,   // L2 irradiance (cosine lobe pre-convolved)
}

struct ProbeSet {
    count:       u32,
    hasGlobalSH: u32,
    envMaxMip:   f32,
    ambientScale: f32,                  // ambient boosts (global × diffuse), for forward shading
    globalSH:    array<vec4<f32>, 9>,   // sky / HDR environment irradiance
    gridMin:     vec2<f32>,             // XZ origin of the probe grid
    gridInvCell: vec2<f32>,             // cells per metre
    cellMask:    array<u32, 1024>,      // PROBE_GRID_DIM², bit i = probes[i] overlaps the cell
    probes:      array<ProbeGPU>,
}

const PROBE_GRID_DIM = 32;

// Bitmask of the probes that may weigh at `worldPos` (ProbeManager.buildGrid). Loop it with
//   while (mask != 0u) { let i = firstTrailingBit(mask); mask &= mask - 1u; … }
fn probeMask(worldPos: vec3<f32>) -> u32 {
    let cell = vec2<i32>(floor((worldPos.xz - probeSet.gridMin) * probeSet.gridInvCell));
    if (any(cell < vec2<i32>(0)) || any(cell >= vec2<i32>(PROBE_GRID_DIM))) { return 0u; }
    return probeSet.cellMask[cell.y * PROBE_GRID_DIM + cell.x];
}

fn evalSHProbe(c: array<vec4<f32>, 9>, N: vec3<f32>) -> vec3<f32> {
    let x = N.x; let y = N.y; let z = N.z;
    var r = c[0].rgb * 0.282095;
    r += c[1].rgb * (0.488603 * y);
    r += c[2].rgb * (0.488603 * z);
    r += c[3].rgb * (0.488603 * x);
    r += c[4].rgb * (1.092548 * x * y);
    r += c[5].rgb * (1.092548 * y * z);
    r += c[6].rgb * (0.315392 * (3.0 * z * z - 1.0));
    r += c[7].rgb * (1.092548 * x * z);
    r += c[8].rgb * (0.546274 * (x * x - y * y));
    return max(r, vec3<f32>(0.0));
}

// Per axis: 0 beyond box + fade, 0.5 on the box face, 1 once `fade` inside it. Separate
// fades let grid cells cross-fade wide horizontally while staying sharp at floor level.
// Takes the index, not a ProbeGPU: copying the struct out of the storage buffer loads all
// 13 vec4 (SH included) per probe per pixel, and this runs for every active probe.
fn probeWeight(i: u32, worldPos: vec3<f32>) -> f32 {
    let inside = min(worldPos - probeSet.probes[i].boxMin.xyz, probeSet.probes[i].boxMax.xyz - worldPos);
    let fade = max(probeSet.probes[i].fade.xyz, vec3<f32>(1e-3));
    if (any(inside <= -fade)) { return 0.0; }
    let w = smoothstep(-fade, fade, inside);
    return min(w.x, min(w.y, w.z));
}

struct ProbeIrradiance {
    irradiance: vec3<f32>,
    coverage:   f32,   // how much of it came from probes (0–1)
}

fn probeIrradiance(worldPos: vec3<f32>, N: vec3<f32>) -> ProbeIrradiance {
    var acc  = vec3<f32>(0.0);
    var wsum = 0.0;
    var mask = probeMask(worldPos);
    while (mask != 0u) {
        let i = firstTrailingBit(mask);
        mask &= mask - 1u;
        let w = probeWeight(i, worldPos);
        if (w > 0.0) {
            acc  += evalSHProbe(probeSet.probes[i].sh, N) * w;
            wsum += w;
        }
    }
    var out: ProbeIrradiance;
    out.coverage = min(wsum, 1.0);
    out.irradiance = acc / max(wsum, 1.0);
    if (probeSet.hasGlobalSH != 0u) {
        out.irradiance += evalSHProbe(probeSet.globalSH, N) * (1.0 - out.coverage);
        out.coverage = 1.0;
    }
    return out;
}


// The two strongest probes with a cubemap at this point.
struct ProbePair {
    a: u32, wa: f32,
    b: u32, wb: f32,
}

fn dominantProbes(worldPos: vec3<f32>) -> ProbePair {
    var pair: ProbePair;
    pair.a = 0u; pair.wa = 0.0;
    pair.b = 0u; pair.wb = 0.0;
    var mask = probeMask(worldPos);
    while (mask != 0u) {
        let i = firstTrailingBit(mask);
        mask &= mask - 1u;
        if (probeSet.probes[i].boxMax.w < 0.0) { continue; }
        let w = probeWeight(i, worldPos);
        if (w > pair.wa) {
            pair.b = pair.a; pair.wb = pair.wa;
            pair.a = i;      pair.wa = w;
        } else if (w > pair.wb) {
            pair.b = i; pair.wb = w;
        }
    }
    return pair;
}

fn sampleProbeEnv(i: u32, worldPos: vec3<f32>, R: vec3<f32>, mip: f32,
                  smp: sampler) -> vec3<f32> {
    let pos = probeSet.probes[i].pos;
    let boxMax = probeSet.probes[i].boxMax;
    var dir = R;
    if (pos.w > 1.5) {
        dir = parallaxCorrectDir(worldPos, R, pos.xyz, probeSet.probes[i].boxMin.xyz, boxMax.xyz);
    }
    return textureSampleLevel(probeEnvArray, smp, dir, i32(boxMax.w), mip).rgb;
}

// Prefiltered specular radiance: probes where they cover the point, `globalEnv` elsewhere.
fn probeSpecular(worldPos: vec3<f32>, R: vec3<f32>, mip: f32, smp: sampler,
                 globalEnv: vec3<f32>) -> vec3<f32> {
    let pair = dominantProbes(worldPos);
    let wsum = pair.wa + pair.wb;
    if (wsum <= 0.0) { return globalEnv; }
    var env = sampleProbeEnv(pair.a, worldPos, R, mip, smp) * pair.wa;
    if (pair.wb > 0.0) {
        env += sampleProbeEnv(pair.b, worldPos, R, mip, smp) * pair.wb;
    }
    let coverage = min(wsum, 1.0);
    return env / max(wsum, 1.0) + globalEnv * (1.0 - coverage);
}
