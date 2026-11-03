// ---------------------------------------------------------------------------
// GI radiance cache update (GIRadianceCache.ts): shades up to cacheInfo.y cells of the active
// list per frame, rotating through it, at the cell's latest sample point: sun + local lights
// (cacheInfo.z shadow rays from the light grid) + last frame's probes (multi-bounce) +
// emissive. The result is blended into the cell's radiance: a running mean of the first samples,
// then at least cache.z per update so lights that change still show within a few updates.
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

struct GICacheActive {
    count: u32,
    evictFrames: u32,
    pad0: u32,
    pad1: u32,
    cells: array<u32>,
}
@group(2) @binding(0) var<storage, read> giCacheActive: GICacheActive;

#include "gi/common/gi_sampling"
#include "gi/common/gi_shading"
#include "gi/common/gi_cache"

/** Samples after which a cell stops averaging and blends at the minimum rate. */
const MAX_SAMPLES: f32 = 64.0;

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let count = giCacheActive.count;
    let budget = giParams.cacheInfo.y;
    if (gid.x >= min(count, budget)) { return; }
    // Rotate through the list: every live cell is shaded once per ceil(count / budget) frames.
    let slot = giCacheActive.cells[(giParams.frameInfo.x * budget + gid.x) % count];

    let cell = giCacheCells[slot];
    let n = giCacheNormal(cell);
    let albedo = unpack4x8unorm(cell.info.x).rgb;
    let emissive = bitcast<f32>(cell.info.y);
    let seed = giHash(slot ^ (giParams.frameInfo.x * 0x9e3779b9u));
    let L = giShadeSurface(cell.sample.xyz, n, albedo, emissive, n, seed, giParams.cacheInfo.z);

    let samples = cell.radiance.w;
    let alpha = max(1.0 / (samples + 1.0), giParams.cache.z);
    let radiance = mix(cell.radiance.rgb, L, alpha);
    giCacheCells[slot].radiance = vec4<f32>(radiance, min(samples + 1.0, MAX_SAMPLES));
}
