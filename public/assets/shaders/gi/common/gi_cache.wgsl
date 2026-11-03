// ─── Realtime GI: world radiance cache (GIRadianceCache.ts) ───────────────────
//
// Spatial hash of surface cells (Binder et al., "Fast path space filtering"; NVIDIA SHaRC).
// A cell is a cube of giParams.cache.x · 2^lod metres, lod growing with the distance to the
// camera (lod = floor(log2(1 + d / cache.y))), split by the dominant axis of the normal so the
// two sides of a thin wall never share a cell. Open addressing: the hash picks a slot, up to
// GI_CACHE_PROBES linear probes; giCacheKeys[slot] holds the cell's fingerprint (0 = empty).
//
// Per cell (giCacheCells):
//   radiance  rgb = outgoing radiance (Lambert: albedo · E/π + albedo · emissive), w = samples
//             accumulated (0 = never shaded: callers shade inline)
//   sample    xyz = a hit position inside the cell, w = octahedral normal (pack2x16snorm)
//   info      x = albedo (pack4x8unorm), y = emissive (f32 bits), z = frame last used
// Every ray that lands in a cell overwrites `sample`/`info` (racy on purpose: any hit in the cell
// is a valid sample point, so updates wander over the cell's area). gi_cache_compact.cs evicts
// cells unused for a while and lists the rest; gi_cache_update.cs shades a budget of them per
// frame and blends into `radiance`.
//
// Includers include gi/common/gi_common first and declare giParams and
//   var<storage, read_write> giCacheKeys: array<atomic<u32>>;
//   var<storage, read_write> giCacheCells: array<GICacheCell>;

struct GICacheCell {
    radiance: vec4<f32>,
    sample:   vec4<f32>,
    info:     vec4<u32>,
}

const GI_CACHE_PROBES: u32 = 8u;
const GI_CACHE_MAX_LOD: f32 = 6.0;

/** (slot hash, fingerprint ≠ 0) of the cell holding a surface point. */
fn giCacheKey(pos: vec3<f32>, n: vec3<f32>) -> vec2<u32> {
    let d = distance(pos, giParams.cameraPos.xyz);
    let lod = min(floor(log2(1.0 + d / giParams.cache.y)), GI_CACHE_MAX_LOD);
    let size = giParams.cache.x * exp2(lod);
    let q = vec3<i32>(floor(pos / size));
    let a = abs(n);
    let axis = select(select(2u, 1u, a.y >= a.z), 0u, a.x >= a.y && a.x >= a.z);
    let face = axis * 2u + select(0u, 1u, n[axis] < 0.0);
    var h = giHash(u32(lod) * 8u + face);
    h = giHash(h ^ bitcast<u32>(q.x));
    h = giHash(h ^ bitcast<u32>(q.y));
    h = giHash(h ^ bitcast<u32>(q.z));
    return vec2<u32>(h, giHash(h ^ 0x68bc21ebu) | 1u);
}

/**
 * Slot of the cell holding (pos, n), or GI_MISS. With `insert`, a missing cell takes the first
 * free slot of its probe sequence (GI_MISS only when all GI_CACHE_PROBES slots are taken).
 */
fn giCacheFind(pos: vec3<f32>, n: vec3<f32>, insert: bool) -> u32 {
    let key = giCacheKey(pos, n);
    let mask = giParams.cacheInfo.x - 1u;
    for (var i = 0u; i < GI_CACHE_PROBES; i++) {
        let slot = (key.x + i) & mask;
        var current = atomicLoad(&giCacheKeys[slot]);
        if (current == key.y) { return slot; }
        if (current != 0u) { continue; }
        if (!insert) { return GI_MISS; }
        // Weak compare-exchange may fail spuriously: retry while the slot still reads empty.
        for (var attempt = 0u; attempt < 4u; attempt++) {
            let r = atomicCompareExchangeWeak(&giCacheKeys[slot], 0u, key.y);
            if (r.exchanged || r.old_value == key.y) { return slot; }
            if (r.old_value != 0u) { break; }
        }
    }
    return GI_MISS;
}

/**
 * Records a hit as the cell's sample point and marks it used this frame. Only the first hits
 * of a frame write: thousands of neighbouring rays land in the same cell, and their stores to
 * one address would serialise.
 */
fn giCacheTouch(slot: u32, pos: vec3<f32>, n: vec3<f32>, albedo: vec3<f32>, emissive: f32) {
    if (giCacheCells[slot].info.z == giParams.frameInfo.x) { return; }
    giCacheCells[slot].sample = vec4<f32>(pos, bitcast<f32>(pack2x16snorm(giOctEncode(n))));
    giCacheCells[slot].info = vec4<u32>(
        pack4x8unorm(vec4<f32>(albedo, 1.0)),
        bitcast<u32>(emissive),
        giParams.frameInfo.x,
        0u,
    );
}

fn giCacheNormal(cell: GICacheCell) -> vec3<f32> {
    return giOctDecode(unpack2x16snorm(bitcast<u32>(cell.sample.w)));
}
