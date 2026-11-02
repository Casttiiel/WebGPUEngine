// ─── Realtime GI: radiance leaving a traced hit ───────────────────────────────
//
// Lambertian with the hit's baked albedo:
//   L = albedo/π · (E_sun + E_lights + E_indirect) + albedo · emissive
// E_sun     : directional light, shadow ray through the BVH.
// E_lights  : one light picked in proportion to its unshadowed contribution, one shadow ray,
//             divided by its pick probability (unbiased; probe hysteresis absorbs the noise).
// E_indirect: last frame's probe irradiance at the hit → infinite bounces over time.
// Same attenuation as tiled_lighting.fs (smoothstep from start falloff to radius, squared
// cone fade) but plain N·L instead of the half-Lambert direct lighting uses.
//
// Includers declare giParams, probeSet (common/probes), giLights, giProbeState and the atlases,
// and include gi/common/gi_common, gi/common/gi_sampling, gi/common/bvh, common/probes first.

const GI_SHADOW_BIAS: f32 = 0.02;
const GI_SHADOW_DISTANCE: f32 = 1.0e4;

/** Sky radiance along `dir`: the environment's irradiance SH / π, times the ambient boost. */
fn giSkyRadiance(dir: vec3<f32>) -> vec3<f32> {
    var e: vec3<f32>;
    if (probeSet.hasGlobalSH != 0u) {
        e = evalSHProbe(probeSet.globalSH, dir);
    } else {
        // Same placeholder as ambient.fs before the environment loads.
        let hemi = dir.y * 0.5 + 0.5;
        e = mix(vec3<f32>(0.10, 0.07, 0.04), vec3<f32>(0.38, 0.50, 0.65), hemi);
    }
    return e * GI_INV_PI * probeSet.ambientScale * giParams.tuning.y;
}

/** Unshadowed irradiance from light `i` at a surface point. */
fn giLightIrradiance(i: u32, pos: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    let light = giLights[i];
    let toLight = light.posRadius.xyz - pos;
    let dist = length(toLight);
    let r1 = light.posRadius.w;
    if (dist >= r1 || dist < 1e-4) { return vec3<f32>(0.0); }
    let L = toLight / dist;
    let NdL = dot(n, L);
    if (NdL <= 0.0) { return vec3<f32>(0.0); }

    let r0 = light.colorFalloff.w;
    var att = 1.0;
    if (dist > r0) {
        let t = saturate((dist - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }
    let cosHalf = light.dirCos.w;
    if (cosHalf > -1.5) {
        let cosAngle = dot(-L, light.dirCos.xyz);
        if (cosAngle < cosHalf) { return vec3<f32>(0.0); }
        let cone = saturate((cosAngle - cosHalf) / max(1.0 - cosHalf, 0.001));
        att *= cone * cone;
    }
    return light.colorFalloff.rgb * (NdL * att);
}

/** Radiance a front-facing hit sends back along -rayDir. */
fn giShadeHit(s: GISurface, rayDir: vec3<f32>, seed: u32) -> vec3<f32> {
    let origin = s.pos + s.normal * GI_SHADOW_BIAS;
    var E = vec3<f32>(0.0);

    if (giParams.sunDir.w > 0.5) {
        let NdL = dot(s.normal, giParams.sunDir.xyz);
        if (NdL > 0.0) {
            let sh = giTrace(origin, giParams.sunDir.xyz, GI_SHADOW_DISTANCE, true);
            if (sh.tri == GI_MISS) { E += giParams.sunColor.rgb * NdL; }
        }
    }

    // Weighted reservoir of one light.
    var rng = seed;
    var wsum = 0.0;
    var chosen = GI_MISS;
    var chosenE = vec3<f32>(0.0);
    var chosenW = 0.0;
    for (var i = 0u; i < giParams.frameInfo.y; i++) {
        let e = giLightIrradiance(i, s.pos, s.normal);
        let w = dot(e, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (w <= 0.0) { continue; }
        wsum += w;
        if (giRand(&rng) * wsum < w) {
            chosen = i;
            chosenE = e;
            chosenW = w;
        }
    }
    if (chosen != GI_MISS) {
        let toLight = giLights[chosen].posRadius.xyz - origin;
        let dist = length(toLight);
        let sh = giTrace(origin, toLight / dist, max(dist - 0.05, 0.0), true);
        if (sh.tri == GI_MISS) { E += chosenE * (wsum / chosenW); }
    }

    if ((giParams.frameInfo.w & GI_FLAG_MULTIBOUNCE) != 0u) {
        let ind = giSampleIrradiance(s.pos, s.normal, -rayDir);
        E += ind.rgb * giParams.tuning2.w;
    }

    return s.albedo * (E * GI_INV_PI + s.emissive);
}
