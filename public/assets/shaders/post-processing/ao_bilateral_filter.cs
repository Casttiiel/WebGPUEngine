#include "common/uniforms"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// AO Bilateral Filter — SEPARABLE compute shader with shared memory tile cache
//
// Pass 0 (cs_h): horizontal  — workgroup 16×8,  tile (16+2R)×8  = 22×8  = 176
// Pass 1 (cs_v): vertical    — workgroup  8×16, tile  8×(16+2R) = 8×22  = 176
//
// Reducing texture fetches from 147/pixel (2D 7×7) to ~11/pixel by:
//   1. Separating into two 1D passes (7 samples instead of 49)
//   2. Amortising texture reads with workgroup-shared tile caching
// ---------------------------------------------------------------------------

const BILATERAL_RADIUS: i32 = 3;
const SIGMA_DEPTH:  f32     = 0.02;
const SIGMA_NORMAL: f32     = 0.3;

// Tile is 176 elements for BOTH passes (symmetric):
//   Horizontal: TILE_W_H=22  TILE_H_H=8   → 22*8  = 176
//   Vertical:   TILE_W_V=8   TILE_H_V=22  → 8*22  = 176
const TILE_ELEM: u32 = 176u;
const TILE_W_H:  u32 = 22u;  // horizontal stride
const TILE_W_V:  u32 = 8u;   // vertical stride

var<workgroup> tileAO:    array<f32, TILE_ELEM>;
var<workgroup> tileDepth: array<f32, TILE_ELEM>;
var<workgroup> tileNX:    array<f32, TILE_ELEM>;
var<workgroup> tileNY:    array<f32, TILE_ELEM>;

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var aoTexture: texture_2d<f32>;
@group(2) @binding(1) var samplerAO: sampler;

@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

// ── Horizontal pass — 16×8 workgroup, halo in X ──────────────────────────────
@compute @workgroup_size(16, 8, 1)
fn cs_h(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id)  lid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let dstSize   = vec2<i32>(textureDimensions(outputAO));
    let texelSize = 1.0 / vec2<f32>(dstSize);
    let groupBase = vec2<i32>(wid.xy) * vec2<i32>(16, 8);

    // ── Cooperative tile load: 22×8 = 176 elements, halo ±R in X ────────────
    let localIdx = lid.y * 16u + lid.x; // 128 threads → 2 iterations to cover 176
    for (var k = localIdx; k < TILE_ELEM; k += 128u) {
        let tx = i32(k % TILE_W_H);
        let ty = i32(k / TILE_W_H);
        let srcCoord = clamp(
            groupBase + vec2<i32>(tx - BILATERAL_RADIUS, ty),
            vec2<i32>(0), dstSize - vec2<i32>(1)
        );
        let uv = (vec2<f32>(srcCoord) + 0.5) * texelSize;
        tileAO[k]    = textureSampleLevel(aoTexture,    samplerAO,     uv, 0.0).r;
        tileDepth[k] = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
        let nd = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0).xy;
        tileNX[k] = nd.x;
        tileNY[k] = nd.y;
    }
    workgroupBarrier();

    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    // Center position within tile (lid.x + halo offset for X)
    let lx = i32(lid.x) + BILATERAL_RADIUS;
    let ly = i32(lid.y);
    let centerIdx = u32(ly) * TILE_W_H + u32(lx);

    let centerDepth = tileDepth[centerIdx];
    if (centerDepth > 0.99) {
        textureStore(outputAO, coords, vec4<f32>(1.0, 0.0, 0.0, 1.0));
        return;
    }

    let centerN  = octahedral01ToNormal(vec2<f32>(tileNX[centerIdx], tileNY[centerIdx]));
    let centerAO = tileAO[centerIdx];

    var filteredAO  = 0.0;
    var totalWeight = 0.0;

    for (var r = -BILATERAL_RADIUS; r <= BILATERAL_RADIUS; r++) {
        let idx    = u32(ly) * TILE_W_H + u32(lx + r);
        let sAO    = tileAO[idx];
        let sDepth = tileDepth[idx];
        let sN     = octahedral01ToNormal(vec2<f32>(tileNX[idx], tileNY[idx]));

        let depthDiff  = abs(centerDepth - sDepth);
        let normalDiff = 1.0 - max(dot(centerN, sN), 0.0);
        let w = exp(-f32(r * r) / (2.0 * f32(BILATERAL_RADIUS * BILATERAL_RADIUS)))
              * exp(-depthDiff  / SIGMA_DEPTH)
              * exp(-normalDiff / SIGMA_NORMAL);

        filteredAO  += sAO * w;
        totalWeight += w;
    }

    let result = select(centerAO, filteredAO / totalWeight, totalWeight > 1e-5);
    textureStore(outputAO, coords, vec4<f32>(result, 0.0, 0.0, 1.0));
}

// ── Vertical pass — 8×16 workgroup, halo in Y ────────────────────────────────
@compute @workgroup_size(8, 16, 1)
fn cs_v(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id)  lid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let dstSize   = vec2<i32>(textureDimensions(outputAO));
    let texelSize = 1.0 / vec2<f32>(dstSize);
    let groupBase = vec2<i32>(wid.xy) * vec2<i32>(8, 16);

    // ── Cooperative tile load: 8×22 = 176 elements, halo ±R in Y ────────────
    let localIdx = lid.y * 8u + lid.x; // 128 threads → 2 iterations to cover 176
    for (var k = localIdx; k < TILE_ELEM; k += 128u) {
        let tx = i32(k % TILE_W_V);
        let ty = i32(k / TILE_W_V);
        let srcCoord = clamp(
            groupBase + vec2<i32>(tx, ty - BILATERAL_RADIUS),
            vec2<i32>(0), dstSize - vec2<i32>(1)
        );
        let uv = (vec2<f32>(srcCoord) + 0.5) * texelSize;
        tileAO[k]    = textureSampleLevel(aoTexture,    samplerAO,     uv, 0.0).r;
        tileDepth[k] = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
        let nd = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0).xy;
        tileNX[k] = nd.x;
        tileNY[k] = nd.y;
    }
    workgroupBarrier();

    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    // Center position within tile (lid.y + halo offset for Y)
    let lx = i32(lid.x);
    let ly = i32(lid.y) + BILATERAL_RADIUS;
    let centerIdx = u32(ly) * TILE_W_V + u32(lx);

    let centerDepth = tileDepth[centerIdx];
    if (centerDepth > 0.99) {
        textureStore(outputAO, coords, vec4<f32>(1.0, 0.0, 0.0, 1.0));
        return;
    }

    let centerN  = octahedral01ToNormal(vec2<f32>(tileNX[centerIdx], tileNY[centerIdx]));
    let centerAO = tileAO[centerIdx];

    var filteredAO  = 0.0;
    var totalWeight = 0.0;

    for (var r = -BILATERAL_RADIUS; r <= BILATERAL_RADIUS; r++) {
        let idx    = u32(ly + r) * TILE_W_V + u32(lx);
        let sAO    = tileAO[idx];
        let sDepth = tileDepth[idx];
        let sN     = octahedral01ToNormal(vec2<f32>(tileNX[idx], tileNY[idx]));

        let depthDiff  = abs(centerDepth - sDepth);
        let normalDiff = 1.0 - max(dot(centerN, sN), 0.0);
        let w = exp(-f32(r * r) / (2.0 * f32(BILATERAL_RADIUS * BILATERAL_RADIUS)))
              * exp(-depthDiff  / SIGMA_DEPTH)
              * exp(-normalDiff / SIGMA_NORMAL);

        filteredAO  += sAO * w;
        totalWeight += w;
    }

    let result = select(centerAO, filteredAO / totalWeight, totalWeight > 1e-5);
    textureStore(outputAO, coords, vec4<f32>(result, 0.0, 0.0, 1.0));
}

// ── PSX variant — Bayer 4×4 dither applied to filtered AO ────────────────────
// Thresholds the smooth 0-1 AO value against the ordered-dither matrix so output
// is a hard 0 or 1 per pixel, matching the stippled look of PSX-style rendering.
fn bayer4ao(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

@compute @workgroup_size(8, 16, 1)
fn cs_v_psx(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id)  lid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let dstSize   = vec2<i32>(textureDimensions(outputAO));
    let texelSize = 1.0 / vec2<f32>(dstSize);
    let groupBase = vec2<i32>(wid.xy) * vec2<i32>(8, 16);

    let localIdx = lid.y * 8u + lid.x;
    for (var k = localIdx; k < TILE_ELEM; k += 128u) {
        let tx = i32(k % TILE_W_V);
        let ty = i32(k / TILE_W_V);
        let srcCoord = clamp(
            groupBase + vec2<i32>(tx, ty - BILATERAL_RADIUS),
            vec2<i32>(0), dstSize - vec2<i32>(1)
        );
        let uv = (vec2<f32>(srcCoord) + 0.5) * texelSize;
        tileAO[k]    = textureSampleLevel(aoTexture,    samplerAO,     uv, 0.0).r;
        tileDepth[k] = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
        let nd = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0).xy;
        tileNX[k] = nd.x;
        tileNY[k] = nd.y;
    }
    workgroupBarrier();

    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    let lx = i32(lid.x);
    let ly = i32(lid.y) + BILATERAL_RADIUS;
    let centerIdx = u32(ly) * TILE_W_V + u32(lx);

    let centerDepth = tileDepth[centerIdx];
    if (centerDepth > 0.99) {
        textureStore(outputAO, coords, vec4<f32>(1.0, 0.0, 0.0, 1.0));
        return;
    }

    let centerN  = octahedral01ToNormal(vec2<f32>(tileNX[centerIdx], tileNY[centerIdx]));
    let centerAO = tileAO[centerIdx];

    var filteredAO  = 0.0;
    var totalWeight = 0.0;

    for (var r = -BILATERAL_RADIUS; r <= BILATERAL_RADIUS; r++) {
        let idx    = u32(ly + r) * TILE_W_V + u32(lx);
        let sAO    = tileAO[idx];
        let sDepth = tileDepth[idx];
        let sN     = octahedral01ToNormal(vec2<f32>(tileNX[idx], tileNY[idx]));

        let depthDiff  = abs(centerDepth - sDepth);
        let normalDiff = 1.0 - max(dot(centerN, sN), 0.0);
        let w = exp(-f32(r * r) / (2.0 * f32(BILATERAL_RADIUS * BILATERAL_RADIUS)))
              * exp(-depthDiff  / SIGMA_DEPTH)
              * exp(-normalDiff / SIGMA_NORMAL);

        filteredAO  += sAO * w;
        totalWeight += w;
    }

    let result = select(centerAO, filteredAO / totalWeight, totalWeight > 1e-5);
    // Threshold smooth AO against Bayer matrix → hard 0 or 1 per pixel (PSX stipple)
    let ditheredAO = select(0.0, 1.0, result > bayer4ao(vec2<u32>(gid.xy)));
    textureStore(outputAO, coords, vec4<f32>(ditheredAO, 0.0, 0.0, 1.0));
}
