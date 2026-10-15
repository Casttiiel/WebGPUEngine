#include "common/uniforms"

// Keep in sync with TiledLightManager.MAX_LIGHTS_PER_TILE
const MAX_LIGHTS_PER_TILE: u32 = 64u;
const TILE_SIZE:            u32 = 16u;

struct PointLightEntry {
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = worldPos, w = outerRadius
    falloff:        vec4<f32>,  // x = startFalloff, yzw = pad
}

struct SpotLightEntry {
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = worldPos, w = outerRadius
    falloff:        vec4<f32>,  // x = startFalloff, yzw = pad
    dirCosAngle:    vec4<f32>,  // xyz = forward dir, w = cos(outerHalfAngle)
}

struct TiledCullingParams {
    pointCount: u32,
    spotCount:  u32,
    numTilesX:  u32,
    numTilesY:  u32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform>               cullingParams:    TiledCullingParams;
@group(1) @binding(1) var<storage, read>          pointLights:      array<PointLightEntry>;
@group(1) @binding(2) var<storage, read>          spotLights:       array<SpotLightEntry>;
@group(1) @binding(3) var<storage, read_write>    tileLightCounts:  array<vec2<u32>>;
@group(1) @binding(4) var<storage, read_write>    tilePointLists:   array<u32>;
@group(1) @binding(5) var<storage, read_write>    tileSpotLists:    array<u32>;

var<workgroup> wgPointCount: atomic<u32>;
var<workgroup> wgSpotCount:  atomic<u32>;
var<workgroup> wgPointList: array<u32, MAX_LIGHTS_PER_TILE>;
var<workgroup> wgSpotList:  array<u32, MAX_LIGHTS_PER_TILE>;

// Unproject an NDC xy point at z=1 back to a view-space direction ray.
fn ndcToViewRay(ndcXY: vec2<f32>) -> vec3<f32> {
    let clip = vec4<f32>(ndcXY, 1.0, 1.0);
    let v    = camera.invProjection * clip;
    return normalize(v.xyz / v.w);
}

// Test a world-space sphere against the 4 tile frustum planes (view space, through origin)
// plus a simple behind-camera and far-plane guard.
fn sphereInsideTile(
    center_WS: vec3<f32>, radius: f32,
    pL: vec3<f32>, pR: vec3<f32>, pT: vec3<f32>, pB: vec3<f32>,
) -> bool {
    let c = (camera.viewMatrix * vec4<f32>(center_WS, 1.0)).xyz;
    // Entirely behind the camera (positive-Z in right-handed view space)
    if (c.z - radius > 0.0)             { return false; }
    // Entirely beyond the far plane
    if (c.z + radius < -camera.cameraFar) { return false; }
    // Four tile frustum planes — all pass through origin in view space
    if (dot(pL, c) < -radius) { return false; }
    if (dot(pR, c) < -radius) { return false; }
    if (dot(pT, c) < -radius) { return false; }
    if (dot(pB, c) < -radius) { return false; }
    return true;
}

@compute @workgroup_size(16, 16)
fn cs_tileLight(
    @builtin(workgroup_id)            wgId:     vec3<u32>,
    @builtin(local_invocation_index)  localIdx: u32,
) {
    let tileX = wgId.x;
    let tileY = wgId.y;

    // Initialise workgroup accumulators
    if (localIdx == 0u) {
        atomicStore(&wgPointCount, 0u);
        atomicStore(&wgSpotCount,  0u);
    }
    workgroupBarrier();

    let sw = camera.screenSize.x;
    let sh = camera.screenSize.y;
    let T  = f32(TILE_SIZE);

    // Tile NDC corners (NDC Y flipped vs screen Y: top of screen = +1)
    let ndcMinX = f32(tileX)      * T / sw * 2.0 - 1.0;
    let ndcMaxX = f32(tileX + 1u) * T / sw * 2.0 - 1.0;
    let ndcMaxY = 1.0 - f32(tileY)      * T / sh * 2.0;   // top of tile
    let ndcMinY = 1.0 - f32(tileY + 1u) * T / sh * 2.0;  // bottom of tile

    // Four corner rays in view space
    let r_TL = ndcToViewRay(vec2<f32>(ndcMinX, ndcMaxY));
    let r_TR = ndcToViewRay(vec2<f32>(ndcMaxX, ndcMaxY));
    let r_BL = ndcToViewRay(vec2<f32>(ndcMinX, ndcMinY));
    let r_BR = ndcToViewRay(vec2<f32>(ndcMaxX, ndcMinY));

    // Inward-facing plane normals (all planes pass through origin)
    let pL = normalize(cross(r_BL, r_TL));  // left
    let pR = normalize(cross(r_TR, r_BR));  // right
    let pT = normalize(cross(r_TL, r_TR));  // top
    let pB = normalize(cross(r_BR, r_BL));  // bottom

    let numThreads = TILE_SIZE * TILE_SIZE;

    // --- Point lights ---
    let pCount = cullingParams.pointCount;
    for (var i = localIdx; i < pCount; i += numThreads) {
        let light = pointLights[i];
        if (sphereInsideTile(light.posRadius.xyz, light.posRadius.w, pL, pR, pT, pB)) {
            let slot = atomicAdd(&wgPointCount, 1u);
            if (slot < MAX_LIGHTS_PER_TILE) {
                wgPointList[slot] = i;
            }
        }
    }

    // --- Spot lights (use bounding sphere conservative cull) ---
    let sCount = cullingParams.spotCount;
    for (var i = localIdx; i < sCount; i += numThreads) {
        let light = spotLights[i];
        if (sphereInsideTile(light.posRadius.xyz, light.posRadius.w, pL, pR, pT, pB)) {
            let slot = atomicAdd(&wgSpotCount, 1u);
            if (slot < MAX_LIGHTS_PER_TILE) {
                wgSpotList[slot] = i;
            }
        }
    }

    workgroupBarrier();

    // Thread 0 writes results to the global tile buffer
    if (localIdx == 0u) {
        let tileIdx = tileY * cullingParams.numTilesX + tileX;
        let fP      = min(atomicLoad(&wgPointCount), MAX_LIGHTS_PER_TILE);
        let fS      = min(atomicLoad(&wgSpotCount),  MAX_LIGHTS_PER_TILE);
        tileLightCounts[tileIdx] = vec2<u32>(fP, fS);
        let baseP = tileIdx * MAX_LIGHTS_PER_TILE;
        let baseS = tileIdx * MAX_LIGHTS_PER_TILE;
        for (var j = 0u; j < fP; j++) { tilePointLists[baseP + j] = wgPointList[j]; }
        for (var j = 0u; j < fS; j++) { tileSpotLists[baseS + j] = wgSpotList[j]; }
    }
}
