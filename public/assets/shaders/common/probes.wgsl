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

#include "common/pcc"

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
    _pad:        f32,
    globalSH:    array<vec4<f32>, 9>,   // sky / HDR environment irradiance
    probes:      array<ProbeGPU>,
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
fn probeWeight(p: ProbeGPU, worldPos: vec3<f32>) -> f32 {
    let inside = min(worldPos - p.boxMin.xyz, p.boxMax.xyz - worldPos);
    let fade = max(p.fade.xyz, vec3<f32>(1e-3));
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
    for (var i = 0u; i < probeSet.count; i++) {
        let w = probeWeight(probeSet.probes[i], worldPos);
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
