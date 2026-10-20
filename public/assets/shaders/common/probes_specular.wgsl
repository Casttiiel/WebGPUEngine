// Specular half of the probe system (common/probes.wgsl): includers also declare
//   var probeEnvArray: texture_cube_array<f32>;

#include "common/probes"

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
