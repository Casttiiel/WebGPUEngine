// ─── Parallax Corrected Cubemap (PCC) ────────────────────────────────────────
//
// Standard cubemaps assume the environment is infinitely far away.
// PCC corrects the reflection/normal vector so it "points" to the right
// position inside the probe's AABB, aligning reflections with real room geometry.
//
// Algorithm (Lagarde & de Rousiers, "Physically Based Rendering in Call of Duty",
//            also used extensively in Uncharted 4 interiors):
//
//   1. For each axis, compute the intersection distance with the near and far
//      slab of the AABB: rbmax = (boxMax - P) / R,  rbmin = (boxMin - P) / R
//   2. Per-component, pick the exit slab:
//         if R > 0  →  exit is boxMax slab  (rbmax)
//         if R < 0  →  exit is boxMin slab  (rbmin)
//   3. The actual exit distance is min(rbminmax.xyz)
//   4. posonbox = P + R * fa   ← world-space hit point on the AABB surface
//   5. Return (posonbox - probePos) — direction from probe capture point to
//      that surface hit.  The cubemap was shot from probePos, so this direction
//      indexes the correct texel.
//
// worldPos  – fragment world-space position
// R         – ray direction to correct (should be normalised)
// probePos  – world-space capture/centre position of the probe
// boxMin    – world-space AABB minimum
// boxMax    – world-space AABB maximum
//
// Returns an unnormalised direction (GPU normalises cube samples implicitly).
fn parallaxCorrectDir(
    worldPos : vec3<f32>,
    R        : vec3<f32>,
    probePos : vec3<f32>,
    boxMin   : vec3<f32>,
    boxMax   : vec3<f32>,
) -> vec3<f32> {
    let rbmax    = (boxMax - worldPos) / R;
    let rbmin    = (boxMin - worldPos) / R;
    // Per-component: pick the exit-slab distance based on ray sign
    let rbminmax = select(rbmin, rbmax, R > vec3<f32>(0.0));
    // Smallest exit distance across all three axes
    let fa       = min(min(rbminmax.x, rbminmax.y), rbminmax.z);
    // World-space hit point → direction from probe capture origin
    let posonbox = worldPos + R * fa;
    return posonbox - probePos;
}
