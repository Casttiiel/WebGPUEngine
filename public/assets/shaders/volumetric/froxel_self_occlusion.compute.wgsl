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

// Number of march steps toward the sun.  12 gives reasonable quality;
// step size is derived from farPlane so they always span the full grid.
const SELF_OCC_STEPS: u32 = 12u;

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

    // Step size: cover 1.5× the far plane so diagonal / low-angle sun marches
    // still span the entire depth range instead of stopping at 32 m.
    let stepSize = far * 1.5 / f32(SELF_OCC_STEPS);

    // Fast perspective coefficients (jitter is subpixel at froxel resolution)
    // projectionMatrix is column-major in WGSL: [col][row]
    let P00 = camera.projectionMatrix[0][0];
    let P11 = camera.projectionMatrix[1][1];

    var T: f32 = 1.0;

    for (var i: u32 = 0u; i < SELF_OCC_STEPS; i++) {
        let sampleVS  = froxelVS + LdirVS * (f32(i) + 0.5) * stepSize;
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

        // Clamp to frustum edge instead of breaking — lets the march continue
        // accumulating when the sun is near the horizon and steps exit the
        // screen boundary, using edge-froxel density as the off-screen proxy.
        let uvXc = clamp(uvX, 0.0, 1.0 - 1e-4);
        let uvYc = clamp(uvY, 0.0, 1.0 - 1e-4);

        let ix = clamp(i32(uvXc * dims.x), 0, dimsI.x - 1);
        let iy = clamp(i32(uvYc * dims.y), 0, dimsI.y - 1);
        let iz = clamp(i32(log(viewDist / near) / logFarNear * dims.z), 0, dimsI.z - 1);

        // 5-tap XY box filter — rg32float is not filterable so we average manually.
        // Smooths self-shadow banding caused by abrupt density jumps at low grid resolution.
        let c  = vec3<i32>(ix, iy, iz);
        let s0 = textureLoad(froxelDensityTexture, c, 0).g;
        let s1 = textureLoad(froxelDensityTexture, vec3<i32>(min(ix + 1, dimsI.x - 1), iy, iz), 0).g;
        let s2 = textureLoad(froxelDensityTexture, vec3<i32>(max(ix - 1, 0),            iy, iz), 0).g;
        let s3 = textureLoad(froxelDensityTexture, vec3<i32>(ix, min(iy + 1, dimsI.y - 1), iz), 0).g;
        let s4 = textureLoad(froxelDensityTexture, vec3<i32>(ix, max(iy - 1, 0),            iz), 0).g;
        let sigmaT = max((s0 + s1 + s2 + s3 + s4) * 0.2, 0.0);
        T *= exp(-sigmaT * stepSize);

        if (T < 0.01) {
            T = 0.0;
            break;
        }
    }

    textureStore(froxelSelfOcclusionTexture, vec3<i32>(gid), vec4<f32>(T, 0.0, 0.0, 0.0));
}
