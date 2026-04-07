// ---------------------------------------------------------------------------
// water_lod.cs — Patch LOD scheduler for WaterVolumeComponent
//
// Two entry points dispatched sequentially each frame:
//
//   1. assign_lod  (dispatch ceil(totalPatches/64))
//      Classifies each patch into one of 3 LOD tiers based on camera distance,
//      then appends the patch descriptor to the appropriate instance array using
//      atomicAdd on a shared counter buffer.
//
//   2. write_indirect  (dispatch 1, workgroup_size 4)
//      Copies the 3 per-LOD atomic counters into drawArgs[i].instanceCount
//      so the GPU indirect draw calls use the correct instance count.
//      Also resets the counters to 0 ready for the next frame.
//
// Bind-group layout (both entries share group 0):
//   @group(0) @binding(0)  camera      CameraUniforms   (uniform)
//   @group(0) @binding(1)  srcPatches  PatchDesc[]      (storage read)
//   @group(0) @binding(2)  counters    atomic<u32>[3]   (storage rw)
//   @group(0) @binding(3)  inst0       InstanceData[]   (storage rw, LOD 0)
//   @group(0) @binding(4)  inst1       InstanceData[]   (storage rw, LOD 1)
//   @group(0) @binding(5)  inst2       InstanceData[]   (storage rw, LOD 2)
//   @group(0) @binding(6)  drawArgs    DrawArgs[3]      (storage rw)
//   @group(0) @binding(7)  lodParams   LodParams        (uniform)
// ---------------------------------------------------------------------------
#include "common/uniforms"

// ── Structs ──────────────────────────────────────────────────────────────────

// Static patch descriptor (world position + size), uploaded once at init.
struct PatchDesc {
    worldX: f32,
    worldZ: f32,
    scale:  f32,
    _pad:   f32,
}

// Dynamic per-instance data read by water_volume.vs  (same layout as PatchDesc).
struct InstanceData {
    worldX: f32,
    worldZ: f32,
    scale:  f32,
    _pad:   f32,
}

// WebGPU drawIndexedIndirect layout (20 bytes / 5 × u32).
struct DrawArgs {
    indexCount:    u32,
    instanceCount: u32,
    firstIndex:    u32,
    baseVertex:    i32,
    firstInstance: u32,
}

// LOD distance thresholds and per-LOD index counts.
// lodDist0: beyond this distance → LOD 1 (medium).
// lodDist1: beyond this distance → LOD 0 (coarse).
// Patches closer than lodDist0 → LOD 2 (fine).
struct LodParams {
    lodDist0: f32,   // near  threshold  (e.g. 20)
    lodDist1: f32,   // far   threshold  (e.g. 60)
    _pad0:    f32,
    _pad1:    f32,
}

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera:      CameraUniforms;
@group(0) @binding(1) var<storage, read>       srcPatches: array<PatchDesc>;
@group(0) @binding(2) var<storage, read_write> counters:   array<atomic<u32>>;  // 3 elements
@group(0) @binding(3) var<storage, read_write> inst0:      array<InstanceData>;
@group(0) @binding(4) var<storage, read_write> inst1:      array<InstanceData>;
@group(0) @binding(5) var<storage, read_write> inst2:      array<InstanceData>;
@group(0) @binding(6) var<storage, read_write> drawArgs:   array<DrawArgs>;     // 3 entries
@group(0) @binding(7) var<uniform> lodParams: LodParams;

// ── Entry 1: assign_lod ───────────────────────────────────────────────────────
// One GPU thread per patch.  Determines LOD from camera distance and appends
// the patch to the appropriate per-LOD instance array.
@compute @workgroup_size(64)
fn assign_lod(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= arrayLength(&srcPatches)) { return; }

    let patch = srcPatches[i];

    // Camera XZ position
    let camXZ = vec2<f32>(camera.cameraPosition.x, camera.cameraPosition.z);

    // Patch centre in world XZ
    let halfScale  = patch.scale * 0.5;
    let patchCenter = vec2<f32>(patch.worldX + halfScale, patch.worldZ + halfScale);

    let dist = distance(camXZ, patchCenter);

    // Determine LOD tier
    var lod: u32;
    if (dist >= lodParams.lodDist1) {
        lod = 0u;  // coarse — far patches
    } else if (dist >= lodParams.lodDist0) {
        lod = 1u;  // medium
    } else {
        lod = 2u;  // fine — near patches
    }

    let inst = InstanceData(patch.worldX, patch.worldZ, patch.scale, 0.0);

    if (lod == 0u) {
        let slot = atomicAdd(&counters[0], 1u);
        inst0[slot] = inst;
    } else if (lod == 1u) {
        let slot = atomicAdd(&counters[1], 1u);
        inst1[slot] = inst;
    } else {
        let slot = atomicAdd(&counters[2], 1u);
        inst2[slot] = inst;
    }
}

// ── Entry 2: write_indirect ───────────────────────────────────────────────────
// 3 threads (one per LOD).  Reads per-LOD counts, writes to drawArgs[i] so
// the indirect draw commands use the freshly computed instance counts.
// Resets counters to 0 for the next frame.
@compute @workgroup_size(4)
fn write_indirect(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= 3u) { return; }

    let count = atomicLoad(&counters[i]);
    drawArgs[i].instanceCount = count;

    // Reset for next frame's assign_lod pass
    atomicStore(&counters[i], 0u);
}
