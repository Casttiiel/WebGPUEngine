// ---------------------------------------------------------------------------
// GI probe integration: one workgroup per probe of this frame's batch (updateInfo).
//   irradiance  — cosine-weighted average of the ray radiance → E (× π), GI_IRR_RES² texels
//   visibility  — mean / mean² hit distance with a sharp cosine lobe, GI_VIS_RES² texels
// Blended with last frame's value by the hysteresis (reset when the slot holds a new probe),
// written with a 1-texel octahedral border into the scratch atlases; RealtimeGI copies the
// batch's atlas rows back into the sampled atlases afterwards.
// ---------------------------------------------------------------------------

#include "gi/common/gi_common"
#include "gi/common/gi_state"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(0) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(0) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(0) @binding(8) var<storage, read> giVolumes: array<GIVolume>;

@group(2) @binding(0) var<storage, read> giRays: array<vec4<f32>>;
@group(2) @binding(1) var outIrradiance: texture_storage_2d<rgba16float, write>;
@group(2) @binding(2) var outVisibility: texture_storage_2d<rgba16float, write>;

const MAX_RAYS: u32 = 64u;

var<workgroup> sRay: array<vec4<f32>, MAX_RAYS>;
var<workgroup> sDir: array<vec4<f32>, MAX_RAYS>;
var<workgroup> sTile: array<vec4<f32>, 196>;  // GI_VIS_RES²

/** Border texel `i` of a res² tile: (destination, source) in tile coordinates (1..res interior). */
fn borderTexel(i: u32, res: u32) -> vec4<u32> {
    let r = res;
    if (i < r)       { return vec4<u32>(1u + i, 0u, r - i, 1u); }
    if (i < 2u * r)  { let j = i - r;      return vec4<u32>(1u + j, r + 1u, r - j, r); }
    if (i < 3u * r)  { let j = i - 2u * r; return vec4<u32>(0u, 1u + j, 1u, r - j); }
    if (i < 4u * r)  { let j = i - 3u * r; return vec4<u32>(r + 1u, 1u + j, r, r - j); }
    let k = i - 4u * r;
    if (k == 0u) { return vec4<u32>(0u, 0u, r, r); }
    if (k == 1u) { return vec4<u32>(r + 1u, 0u, 1u, r); }
    if (k == 2u) { return vec4<u32>(0u, r + 1u, r, 1u); }
    return vec4<u32>(r + 1u, r + 1u, 1u, 1u);
}

/** Rays of the batch's `local`-th probe into workgroup memory. */
fn loadRays(local: u32, li: u32, threads: u32) {
    let rays = giParams.gridInfo.z;
    for (var r = li; r < rays; r += threads) {
        sRay[r] = giRays[local * rays + r];
        sDir[r] = vec4<f32>(giRayDirection(r), 0.0);
    }
}

/**
 * Hysteresis of a probe slot. A young probe averages its updates (n / (n + 1)) until it
 * reaches the configured hysteresis: its first estimates lack the bounce light of neighbours
 * that wrapped in with it, and blending them at 0.97 would keep it dark for seconds after the
 * camera moves. 0 when the slot just started holding a new probe.
 */
fn hysteresis(slot: u32) -> f32 {
    let volume = giParams.gridInfo.w;
    let index = giVolumes[volume].dims.w + slot;
    if (!giProbeHolds(index, giSlotCoord(volume, slot))) { return 0.0; }
    let updates = giProbeState[index * 2u + 1u].w;
    return min(giParams.tuning.x, updates / (updates + 1.0));
}

@compute @workgroup_size(6, 6)
fn irradiance(@builtin(workgroup_id) wg: vec3<u32>,
              @builtin(local_invocation_id) lid: vec3<u32>,
              @builtin(local_invocation_index) li: u32) {
    let slot = giParams.updateInfo.x + wg.x;
    let volume = giParams.gridInfo.w;
    let rays = giParams.gridInfo.z;
    loadRays(wg.x, li, GI_IRR_RES * GI_IRR_RES);
    workgroupBarrier();

    let texDir = giOctDecode((vec2<f32>(lid.xy) + 0.5) / f32(GI_IRR_RES) * 2.0 - 1.0);
    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var r = 0u; r < rays; r++) {
        let ray = sRay[r];
        if (ray.w < 0.0) { continue; }  // back faces add nothing
        let w = max(dot(texDir, sDir[r].xyz), 0.0);
        sum += ray.rgb * w;
        wsum += w;
    }
    // Σ L·cosθ / Σ cosθ over a uniform sphere set = E / π.
    let current = select(vec3<f32>(0.0), sum / wsum * GI_PI, wsum > 1e-4);

    let tileOrigin = giTile(giVolumes[volume].dims.w + slot) * (GI_IRR_RES + 2u);
    let texel = tileOrigin + 1u + lid.xy;
    let prev = textureLoad(giIrradianceAtlas, texel, 0).rgb;
    let result = mix(current, prev, hysteresis(slot));
    sTile[li] = vec4<f32>(result, 1.0);
    textureStore(outIrradiance, texel, sTile[li]);
    workgroupBarrier();

    if (li < 4u * GI_IRR_RES + 4u) {
        let b = borderTexel(li, GI_IRR_RES);
        textureStore(outIrradiance, tileOrigin + b.xy, sTile[(b.w - 1u) * GI_IRR_RES + (b.z - 1u)]);
    }
}

@compute @workgroup_size(14, 14)
fn visibility(@builtin(workgroup_id) wg: vec3<u32>,
              @builtin(local_invocation_id) lid: vec3<u32>,
              @builtin(local_invocation_index) li: u32) {
    let slot = giParams.updateInfo.x + wg.x;
    let volume = giParams.gridInfo.w;
    let rays = giParams.gridInfo.z;
    let maxDist = giVolumes[volume].spacing.x * 3.0;
    loadRays(wg.x, li, GI_VIS_RES * GI_VIS_RES);
    workgroupBarrier();

    let texDir = giOctDecode((vec2<f32>(lid.xy) + 0.5) / f32(GI_VIS_RES) * 2.0 - 1.0);
    var sum = vec2<f32>(0.0);
    var wsum = 0.0;
    for (var r = 0u; r < rays; r++) {
        let w = pow(max(dot(texDir, sDir[r].xyz), 0.0), 50.0);
        if (w <= 0.0) { continue; }
        var d = sRay[r].w;
        // Back-face hits pull the distance in so the probe doesn't light what's behind the wall.
        d = select(d, -d * 0.2, d < 0.0);
        d = min(d, maxDist);
        sum += vec2<f32>(d, d * d) * w;
        wsum += w;
    }
    let current = select(vec2<f32>(maxDist, maxDist * maxDist), sum / wsum, wsum > 1e-6);

    let tileOrigin = giTile(giVolumes[volume].dims.w + slot) * (GI_VIS_RES + 2u);
    let texel = tileOrigin + 1u + lid.xy;
    let prev = textureLoad(giVisibilityAtlas, texel, 0).rg;
    let result = mix(current, prev, hysteresis(slot));
    sTile[li] = vec4<f32>(result, 0.0, 1.0);
    textureStore(outVisibility, texel, sTile[li]);
    workgroupBarrier();

    if (li < 4u * GI_VIS_RES + 4u) {
        let b = borderTexel(li, GI_VIS_RES);
        textureStore(outVisibility, tileOrigin + b.xy, sTile[(b.w - 1u) * GI_VIS_RES + (b.z - 1u)]);
    }
}
