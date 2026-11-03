// ─── Realtime GI: radiance leaving a traced hit ───────────────────────────────
//
// Lambertian with the hit's baked albedo:
//   L = albedo/π · (E_sun + E_lights + E_indirect) + albedo · emissive
// E_sun     : directional light, shadow ray through the BVH.
// E_lights  : the local lights of the point's light-grid cell (gi/common/gi_light_grid), a few
//             shadow rays picked in proportion to each light's unshadowed contribution.
// E_indirect: last frame's probe irradiance at the hit → infinite bounces over time.
// Same attenuation as tiled_lighting.fs (smoothstep from start falloff to radius, squared
// cone fade) but plain N·L instead of the half-Lambert direct lighting uses.
//
// Includers declare giParams, probeSet (common/probes), giLights, giLightGrid, giProbeState and
// the atlases, and include gi/common/gi_common, gi/common/gi_sampling, gi/common/bvh,
// common/probes first.

#include "gi/common/gi_light_grid"

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

/**
 * Radiance a surface point sends toward `view` (unit vector toward whoever looks at it).
 * `lightSamples` = shadow rays for the local lights.
 */
fn giShadeSurface(
    pos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    emissive: f32,
    view: vec3<f32>,
    seed: u32,
    lightSamples: u32,
) -> vec3<f32> {
    var E = vec3<f32>(0.0);

    if (giParams.sunDir.w > 0.5) {
        let NdL = dot(normal, giParams.sunDir.xyz);
        if (NdL > 0.0) {
            let sh = giTrace(pos + normal * GI_SHADOW_BIAS, giParams.sunDir.xyz, GI_SHADOW_DISTANCE, true);
            if (sh.tri == GI_MISS) { E += giParams.sunColor.rgb * NdL; }
        }
    }

    var rng = seed;
    E += giSampleLights(pos, normal, lightSamples, &rng);

    if ((giParams.frameInfo.w & GI_FLAG_MULTIBOUNCE) != 0u) {
        let ind = giSampleIrradiance(pos, normal, view);
        E += ind.rgb * giParams.tuning2.w;
    }

    return albedo * (E * GI_INV_PI + emissive);
}

/** Radiance a front-facing hit sends back along -rayDir (one light sample). */
fn giShadeHit(s: GISurface, rayDir: vec3<f32>, seed: u32) -> vec3<f32> {
    return giShadeSurface(s.pos, s.normal, s.albedo, s.emissive, -rayDir, seed, 1u);
}
