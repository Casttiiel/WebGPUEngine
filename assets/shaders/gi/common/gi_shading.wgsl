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

// ─── Realtime GI: world-space light grid (GIWorldLightGrid.ts) ─────────────────
//
// GI_GRID_CASCADES cascades of GI_GRID_DIM³ cells centred on the camera, cell size doubling per
// cascade (giParams.lightGrid[c]: xyz = world min corner, w = cell size). Each cell lists up to
// GI_CELL_MAX_LIGHTS indices into giLights (all point/spot lights, nearest the camera first, so a
// full cell keeps the ones that matter most): giLightGrid[cell · GI_CELL_STRIDE] = count, then
// the indices. A point uses the finest cascade that contains it; outside every cascade it gets no
// local lights.
//
// Includers include gi/common/gi_common and gi/common/bvh first and declare giParams and
//   var<storage, read> giLights: array<GILight>;
//   var<storage, read> giLightGrid: array<u32>;

const GI_GRID_DIM: u32 = 16u;
const GI_GRID_CASCADES: u32 = 4u;
const GI_CELL_STRIDE: u32 = 32u;
const GI_CELL_MAX_LIGHTS: u32 = 31u;
/** Most light samples (shadow rays) per shaded point. */
const GI_MAX_LIGHT_SAMPLES: u32 = 4u;
const GI_SHADOW_BIAS: f32 = 0.02;

/** First word of the grid cell holding `pos`, or GI_MISS outside every cascade. */
fn giLightGridCell(pos: vec3<f32>) -> u32 {
    for (var c = 0u; c < GI_GRID_CASCADES; c++) {
        let g = giParams.lightGrid[c];
        let local = (pos - g.xyz) / g.w;
        if (all(local >= vec3<f32>(0.0)) && all(local < vec3<f32>(f32(GI_GRID_DIM)))) {
            let cell = vec3<u32>(local);
            let index = c * GI_GRID_DIM * GI_GRID_DIM * GI_GRID_DIM
                      + cell.x + cell.y * GI_GRID_DIM + cell.z * GI_GRID_DIM * GI_GRID_DIM;
            return index * GI_CELL_STRIDE;
        }
    }
    return GI_MISS;
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

/** Shadowed irradiance from light `i`: one shadow ray from `origin` (the biased surface point). */
fn giShadowedLight(i: u32, origin: vec3<f32>, e: vec3<f32>) -> vec3<f32> {
    let toLight = giLights[i].posRadius.xyz - origin;
    let dist = length(toLight);
    let sh = giTrace(origin, toLight / max(dist, 1e-4), max(dist - 0.05, 0.0), true);
    return select(vec3<f32>(0.0), e, sh.tri == GI_MISS);
}

/**
 * Irradiance from the local lights of the point's grid cell, `samples` (≤ GI_MAX_LIGHT_SAMPLES)
 * shadow rays. Every light in the cell is weighed by its unshadowed contribution; when no more
 * than `samples` lights reach the point each gets its own shadow ray (exact, no noise),
 * otherwise `samples` independent weighted reservoirs pick lights with probability ∝ weight and
 * the estimate e_k · Σw / w_k is averaged (unbiased; the radiance cache and probe hysteresis
 * absorb the rest of the noise).
 */
fn giSampleLights(pos: vec3<f32>, n: vec3<f32>, samples: u32, rng: ptr<function, u32>) -> vec3<f32> {
    let cell = giLightGridCell(pos);
    if (cell == GI_MISS) { return vec3<f32>(0.0); }
    let count = min(giLightGrid[cell], GI_CELL_MAX_LIGHTS);
    let k = clamp(samples, 1u, GI_MAX_LIGHT_SAMPLES);
    let origin = pos + n * GI_SHADOW_BIAS;

    var wsum = 0.0;
    var contributing = 0u;
    var first: array<u32, GI_MAX_LIGHT_SAMPLES>;      // the first k contributing lights
    var firstE: array<vec3<f32>, GI_MAX_LIGHT_SAMPLES>;
    var pick: array<u32, GI_MAX_LIGHT_SAMPLES>;       // reservoir picks
    var pickE: array<vec3<f32>, GI_MAX_LIGHT_SAMPLES>;
    var pickW: array<f32, GI_MAX_LIGHT_SAMPLES>;
    for (var j = 0u; j < count; j++) {
        let i = giLightGrid[cell + 1u + j];
        let e = giLightIrradiance(i, pos, n);
        let w = dot(e, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (w <= 0.0) { continue; }
        if (contributing < k) {
            first[contributing] = i;
            firstE[contributing] = e;
        }
        contributing++;
        wsum += w;
        for (var s = 0u; s < k; s++) {
            if (giRand(rng) * wsum < w) {
                pick[s] = i;
                pickE[s] = e;
                pickW[s] = w;
            }
        }
    }
    if (contributing == 0u) { return vec3<f32>(0.0); }

    var E = vec3<f32>(0.0);
    if (contributing <= k) {
        for (var s = 0u; s < contributing; s++) {
            E += giShadowedLight(first[s], origin, firstE[s]);
        }
        return E;
    }
    for (var s = 0u; s < k; s++) {
        E += giShadowedLight(pick[s], origin, pickE[s]) * (wsum / pickW[s]);
    }
    return E / f32(k);
}


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
