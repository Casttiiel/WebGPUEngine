// ---------------------------------------------------------------------------
// GI light grid build (GIWorldLightGrid.ts): one thread per cell of every cascade. Lists the
// lights whose sphere of influence touches the cell's box, in giLights order (nearest the camera
// first), up to GI_CELL_MAX_LIGHTS. Spot lights are culled by their sphere only. Spheres are
// inflated by SLACK: the grid is only rebuilt once a light drifts further (GIWorldLightGrid).
// ---------------------------------------------------------------------------

#include "gi/common/gi_common"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(1) var<storage, read> giLights: array<GILight>;
@group(0) @binding(2) var<storage, read_write> giLightGrid: array<u32>;

const GRID_DIM: u32 = 16u;
const GRID_CASCADES: u32 = 4u;
const CELL_STRIDE: u32 = 32u;
const CELL_MAX_LIGHTS: u32 = 31u;
const SLACK: f32 = 0.1;

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let cellsPerCascade = GRID_DIM * GRID_DIM * GRID_DIM;
    let index = gid.x;
    if (index >= cellsPerCascade * GRID_CASCADES) { return; }
    let c = index / cellsPerCascade;
    let local = index % cellsPerCascade;
    let cell = vec3<u32>(local % GRID_DIM, (local / GRID_DIM) % GRID_DIM, local / (GRID_DIM * GRID_DIM));
    let g = giParams.lightGrid[c];
    let boxMin = g.xyz + vec3<f32>(cell) * g.w;
    let boxMax = boxMin + vec3<f32>(g.w);

    let base = index * CELL_STRIDE;
    var count = 0u;
    for (var i = 0u; i < giParams.frameInfo.y && count < CELL_MAX_LIGHTS; i++) {
        let sphere = giLights[i].posRadius;
        let closest = clamp(sphere.xyz, boxMin, boxMax);
        let d = closest - sphere.xyz;
        let r = sphere.w + SLACK;
        if (dot(d, d) < r * r) {
            giLightGrid[base + 1u + count] = i;
            count++;
        }
    }
    giLightGrid[base] = count;
}
