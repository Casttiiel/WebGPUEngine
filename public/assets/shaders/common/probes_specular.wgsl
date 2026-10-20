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
    for (var i = 0u; i < probeSet.count; i++) {
        let p = probeSet.probes[i];
        if (p.boxMax.w < 0.0) { continue; }
        let w = probeWeight(p, worldPos);
        if (w > pair.wa) {
            pair.b = pair.a; pair.wb = pair.wa;
            pair.a = i;      pair.wa = w;
        } else if (w > pair.wb) {
            pair.b = i; pair.wb = w;
        }
    }
    return pair;
}

fn sampleProbeEnv(p: ProbeGPU, worldPos: vec3<f32>, R: vec3<f32>, mip: f32,
                  smp: sampler) -> vec3<f32> {
    var dir = R;
    if (p.pos.w > 1.5) {
        dir = parallaxCorrectDir(worldPos, R, p.pos.xyz, p.boxMin.xyz, p.boxMax.xyz);
    }
    return textureSampleLevel(probeEnvArray, smp, dir, i32(p.boxMax.w), mip).rgb;
}

// Prefiltered specular radiance: probes where they cover the point, `globalEnv` elsewhere.
fn probeSpecular(worldPos: vec3<f32>, R: vec3<f32>, mip: f32, smp: sampler,
                 globalEnv: vec3<f32>) -> vec3<f32> {
    let pair = dominantProbes(worldPos);
    let wsum = pair.wa + pair.wb;
    if (wsum <= 0.0) { return globalEnv; }
    var env = sampleProbeEnv(probeSet.probes[pair.a], worldPos, R, mip, smp) * pair.wa;
    if (pair.wb > 0.0) {
        env += sampleProbeEnv(probeSet.probes[pair.b], worldPos, R, mip, smp) * pair.wb;
    }
    let coverage = min(wsum, 1.0);
    return env / max(wsum, 1.0) + globalEnv * (1.0 - coverage);
}
