// ---------------------------------------------------------------------------
// GI probe state: one thread per probe of this frame's batch, after integration.
// giProbeState[2i]   = (relocation offset xyz, smoothed back-face ratio)
// giProbeState[2i+1] = (absolute grid coordinate the slot holds, updates since reset)
//
// DDGI-style relocation: a probe whose rays mostly hit back faces is inside geometry → push it
// through the nearest back face; one too close to a front face → pull it away. Offsets stay
// within 0.45 cell so probes keep their place in the grid, and only move during the first
// RELOCATION_UPDATES updates: with a random ray set every frame, relocating forever makes
// probes wander and the lighting shimmer. Likewise the back-face ratio is averaged over
// updates; sampling skips probes whose average says they're inside geometry
// (GI_INACTIVE_RATIO, gi_common.wgsl) — a single unlucky ray set can't switch a probe off.
// ---------------------------------------------------------------------------

#include "gi/common/gi_common"
#include "gi/common/gi_state"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(1) var<storage, read> giRays: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> giProbeState: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> giVolumes: array<GIVolume>;

/** Updates after a reset during which the probe may still move. */
const RELOCATION_UPDATES: f32 = 8.0;
const MIN_FRONT_DISTANCE: f32 = 0.2;   // × spacing
const MAX_OFFSET: f32 = 0.45;          // × spacing

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let local = gid.x;
    if (local >= giParams.updateInfo.y) { return; }
    let slot = giParams.updateInfo.x + local;
    let volume = giParams.gridInfo.w;
    let rays = giParams.gridInfo.z;
    let spacing = giVolumes[volume].spacing.x;
    let coord = giSlotCoord(volume, slot);
    let index = giVolumes[volume].dims.w + slot;
    let reset = !giProbeHolds(index, coord);

    var backfaces = 0u;
    var closestBack = GI_MISS_DISTANCE;
    var closestBackDir = vec3<f32>(0.0);
    var closestFront = GI_MISS_DISTANCE;
    var closestFrontDir = vec3<f32>(0.0);
    for (var r = 0u; r < rays; r++) {
        let d = giRays[local * rays + r].w;
        if (d < 0.0) {
            backfaces++;
            if (-d < closestBack) { closestBack = -d; closestBackDir = giRayDirection(r); }
        } else if (d < closestFront) {
            closestFront = d;
            closestFrontDir = giRayDirection(r);
        }
    }
    let ratio = f32(backfaces) / f32(rays);
    let prev = giProbeState[index * 2u];
    let updates = select(giProbeState[index * 2u + 1u].w + 1.0, 1.0, reset);

    var offset = select(prev.xyz, vec3<f32>(0.0), reset);
    if (updates <= RELOCATION_UPDATES) {
        var candidate = offset;
        if (ratio > GI_INACTIVE_RATIO) {
            candidate = offset + closestBackDir * (closestBack + MIN_FRONT_DISTANCE * spacing * 0.5);
        } else if (closestFront < MIN_FRONT_DISTANCE * spacing) {
            candidate = offset - closestFrontDir * (MIN_FRONT_DISTANCE * spacing - closestFront);
        }
        if (all(abs(candidate) <= vec3<f32>(MAX_OFFSET * spacing))) { offset = candidate; }
    }

    // While relocating, the ratio follows the latest position; afterwards it's a running mean.
    let smoothed = select(mix(ratio, prev.w, 0.9), ratio, reset || updates <= RELOCATION_UPDATES);
    giProbeState[index * 2u] = vec4<f32>(offset, smoothed);
    giProbeState[index * 2u + 1u] = vec4<f32>(vec3<f32>(coord), updates);
}
