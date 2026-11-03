// ---------------------------------------------------------------------------
// GI probe trace: one thread per (probe, ray) of this frame's batch (updateInfo).
// Output per ray (giRays): rgb = radiance arriving at the probe, a = hit distance
// (negative = the ray hit a back face, i.e. the probe sees the inside of geometry;
// GI_MISS_DISTANCE = sky).
// With the radiance cache on (GI_FLAG_CACHE), a front-face hit records itself in its cache
// cell and returns the cell's radiance; only cells never shaded yet are shaded here.
// ---------------------------------------------------------------------------

#include "common/probes"
#include "gi/common/gi_common"
#include "gi/common/bvh"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(2) var<storage, read> probeSet: ProbeSet;
@group(0) @binding(3) var<storage, read> giLights: array<GILight>;
@group(0) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(0) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(0) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(0) @binding(7) var giSampler: sampler;
@group(0) @binding(8) var<storage, read> giVolumes: array<GIVolume>;
@group(0) @binding(9) var<storage, read> giLightGrid: array<u32>;
@group(0) @binding(10) var<storage, read_write> giCacheKeys: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> giCacheCells: array<GICacheCell>;

@group(2) @binding(0) var<storage, read_write> giRays: array<vec4<f32>>;

#include "gi/common/gi_sampling"
#include "gi/common/gi_shading"
#include "gi/common/gi_cache"

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let rays = giParams.gridInfo.z;
    let volume = giParams.gridInfo.w;
    if (gid.x >= giParams.updateInfo.y * rays) { return; }
    // giRays holds this frame's batch only; the slot is relative to the batch start.
    let slot = giParams.updateInfo.x + gid.x / rays;
    let ray = gid.x % rays;

    let coord = giSlotCoord(volume, slot);
    let index = giVolumes[volume].dims.w + slot;
    // A slot that just wrapped in still has the old probe's relocation: start from the cell.
    let offset = select(vec3<f32>(0.0), giProbeState[index * 2u].xyz, giProbeHolds(index, coord));
    let probePos = vec3<f32>(coord) * giVolumes[volume].spacing.x + offset;
    let dir = giRayDirection(ray);

    // Characters stay out of the probes (they get their contact shading from the gather).
    giTraceIgnore = GI_INSTANCE_SKINNED;
    let hit = giTrace(probePos, dir, giParams.tuning2.z, false);
    giTraceIgnore = 0u;
    var result: vec4<f32>;
    if (hit.tri == GI_MISS) {
        result = vec4<f32>(giSkyRadiance(dir), GI_MISS_DISTANCE);
    } else {
        let s = giHitSurface(probePos, dir, hit);
        if (s.frontFace) {
            var radiance = vec3<f32>(-1.0);
            if ((giParams.frameInfo.w & GI_FLAG_CACHE) != 0u) {
                let cell = giCacheFind(s.pos, s.normal, true);
                if (cell != GI_MISS) {
                    giCacheTouch(cell, s.pos, s.normal, s.albedo, s.emissive);
                    let cached = giCacheCells[cell].radiance;
                    if (cached.w > 0.0) { radiance = cached.rgb; }
                }
            }
            if (radiance.x < 0.0) {
                let seed = giHash(gid.x ^ (giParams.frameInfo.x * 0x9e3779b9u));
                radiance = giShadeHit(s, dir, seed);
            }
            result = vec4<f32>(radiance, hit.t);
        } else {
            result = vec4<f32>(0.0, 0.0, 0.0, -hit.t);
        }
    }
    giRays[gid.x] = result;
}
