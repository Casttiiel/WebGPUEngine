// ─── Realtime GI: probe-volume layout helpers ─────────────────────────────────
//
// Includers include gi/common/gi_common first and declare
//   var<storage, read> giVolumes: array<GIVolume>;

fn giPosMod(a: vec3<i32>, n: vec3<i32>) -> vec3<i32> {
    return ((a % n) + n) % n;
}

/** Global probe index of the probe at absolute grid coordinate `coord` of volume `v`. */
fn giProbeIndex(v: u32, coord: vec3<i32>) -> u32 {
    let d = giVolumes[v].dims;
    let s = vec3<u32>(giPosMod(coord, vec3<i32>(d.xyz)));
    return d.w + s.x + s.y * d.x + s.z * d.x * d.y;
}

/** Atlas tile of a global probe index (same in both atlases). */
fn giTile(index: u32) -> vec2<u32> {
    return vec2<u32>(index % giParams.gridInfo.x, index / giParams.gridInfo.x);
}

/** Absolute coordinate held by storage slot `slot` (0..probes in the volume) of volume `v`. */
fn giSlotCoord(v: u32, slot: u32) -> vec3<i32> {
    let d = giVolumes[v].dims;
    let s = vec3<i32>(vec3<u32>(slot % d.x, (slot / d.x) % d.y, slot / (d.x * d.y)));
    let origin = giVolumes[v].origin.xyz;
    return origin + giPosMod(s - origin, vec3<i32>(d.xyz));
}
