// Froxel Self-Occlusion Pass
// For each froxel, marches a ray toward the directional light through the
// density volume, accumulating Beer-law transmittance.  The result (0..1)
// is stored per-froxel and later multiplied with the directional contribution
// in the light injection pass, so dense fog correctly shadows deeper fog.
#include "common/uniforms"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams:       FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Density volume (rg32float: R=sigmaS, G=sigmaT) — read-only
@group(2) @binding(0) var froxelDensityTexture:      texture_3d<f32>;
// Self-occlusion result (r32float: transmittance 0..1) — write
@group(2) @binding(1) var froxelSelfOcclusionTexture: texture_storage_3d<r32float, write>;

// Only need the light direction from the directional light uniform buffer
struct DirLightDir {
    color:     vec3<f32>,
    hasShadow: f32,
    position:  vec3<f32>,  // direction FROM scene TOWARD light (lightDirectionToSource)
    intensity: f32,
}
@group(3) @binding(0) var<uniform> dirLight: DirLightDir;

// ── Tuning ──────────────────────────────────────────────────────────────────
// 8 steps × 4 world-units = 32 m total march.  Enough to cross a 30 m fog
// layer even at sun elevations as low as ~60°.  Increase STEPS for higher
// quality at the cost of more compute.
const SELF_OCC_STEPS:     u32 = 8u;
const SELF_OCC_STEP_SIZE: f32 = 4.0;  // world-units per step
// ────────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = froxelParams.dimensions;

    if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y) || gid.z >= u32(dims.z)) {
        return;
    }

    // ── View-space position of this froxel ───────────────────────────────────
    let froxelVS = froxelToViewSpace(
        gid, dims.xyz,
        froxelParams.nearPlane, froxelParams.farPlane,
        camera.invProjection
    );

    // ── Light direction in view space (direction toward light) ───────────────
    // dirLight.position = lightDirectionToSource (world-space, normalized)
    let LdirVS = normalize((camera.viewMatrix * vec4<f32>(dirLight.position, 0.0)).xyz);

    let near   = froxelParams.nearPlane;
    let far    = froxelParams.farPlane;
    let dimsI  = vec3<i32>(i32(dims.x), i32(dims.y), i32(dims.z));
    let logFarNear = log(far / near);  // precompute once

    // Fast perspective coefficients (jitter is subpixel at froxel resolution)
    // projectionMatrix is column-major in WGSL: [col][row]
    let P00 = camera.projectionMatrix[0][0];
    let P11 = camera.projectionMatrix[1][1];

    var T: f32 = 1.0;

    for (var i: u32 = 0u; i < SELF_OCC_STEPS; i++) {
        let sampleVS  = froxelVS + LdirVS * (f32(i) + 0.5) * SELF_OCC_STEP_SIZE;
        let viewDist  = -sampleVS.z;  // positive distance from camera

        // Outside depth range → clear sky, no more medium to accumulate
        if (viewDist <= near || viewDist >= far) {
            break;
        }

        // Fast perspective-divide to froxel UV (no full mat4 multiply needed)
        let invW  = 1.0 / viewDist;
        let ndcX  = P00 * sampleVS.x * invW;
        let ndcY  = P11 * sampleVS.y * invW;
        let uvX   = ndcX * 0.5 + 0.5;
        let uvY   = 1.0 - (ndcY * 0.5 + 0.5);

        // Outside frustum → clear sky, stop
        if (uvX < 0.0 || uvX >= 1.0 || uvY < 0.0 || uvY >= 1.0) {
            break;
        }

        let ix = clamp(i32(uvX * dims.x), 0, dimsI.x - 1);
        let iy = clamp(i32(uvY * dims.y), 0, dimsI.y - 1);
        let iz = clamp(i32(log(viewDist / near) / logFarNear * dims.z), 0, dimsI.z - 1);

        let sigmaT = max(textureLoad(froxelDensityTexture, vec3<i32>(ix, iy, iz), 0).g, 0.0);
        T *= exp(-sigmaT * SELF_OCC_STEP_SIZE);

        if (T < 0.01) {
            T = 0.0;
            break;
        }
    }

    textureStore(froxelSelfOcclusionTexture, vec3<i32>(gid), vec4<f32>(T, 0.0, 0.0, 0.0));
}
