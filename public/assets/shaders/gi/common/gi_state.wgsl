// ─── Realtime GI: per-probe state helpers ─────────────────────────────────────
//
// Includers include gi/common/gi_common first and declare giVolumes (gi/common/gi_volumes) and
//   var<storage, read> giProbeState: array<vec4<f32>>;   (or read_write)

#include "gi/common/gi_volumes"

/** True when the slot holds `coord` (not a wrapped-in, not-yet-updated probe). */
fn giProbeHolds(index: u32, coord: vec3<i32>) -> bool {
    return all(vec3<i32>(round(giProbeState[index * 2u + 1u].xyz)) == coord);
}
