// ---------------------------------------------------------------------------
// GI radiance cache maintenance (GIRadianceCache.ts): one thread per hash slot, once per frame
// before the update. A cell nobody touched for `evictFrames` frees its slot (radiance cleared
// so the next owner starts unshaded); every other live cell is appended to the active list the
// update pass walks.
// Freed slots can break another cell's probe sequence; that cell is then re-inserted in the
// freed slot and its old copy ages out — a lost history, never a wrong lookup.
// ---------------------------------------------------------------------------

#include "gi/common/gi_common"
#include "gi/common/gi_cache"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(10) var<storage, read_write> giCacheKeys: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> giCacheCells: array<GICacheCell>;

struct GICacheActive {
    count: atomic<u32>,
    evictFrames: u32,
    pad0: u32,
    pad1: u32,
    cells: array<u32>,
}
@group(1) @binding(0) var<storage, read_write> giCacheActive: GICacheActive;

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let slot = gid.x;
    if (slot >= giParams.cacheInfo.x) { return; }
    if (atomicLoad(&giCacheKeys[slot]) == 0u) { return; }
    let age = giParams.frameInfo.x - giCacheCells[slot].info.z;
    if (age > giCacheActive.evictFrames) {
        atomicStore(&giCacheKeys[slot], 0u);
        giCacheCells[slot].radiance = vec4<f32>(0.0);
        return;
    }
    let i = atomicAdd(&giCacheActive.count, 1u);
    giCacheActive.cells[i] = slot;
}
