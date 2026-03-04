// Only the three includes actually used by this shader.
// common/structs, common/math/coordinates, common/math/noise and common/gbuffer
// are NOT needed here (all required types/functions are declared inline).
#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// Ground-Truth Ambient Occlusion — compute shader
// Same algorithm as gtao.fs, ported to @compute so we skip fullscreen-quad
// rasterization and write directly to a storage texture.
// Workgroup 8×8 → 64 threads, each processes one AO-resolution pixel.
// ---------------------------------------------------------------------------

struct SSAOParams {
    sampleCount: f32,
    sliceCount: f32,
    radius: f32,
    aoStrength: f32,
    angleOffset: f32,
    spacialOffset: f32,
    falloff: f32,
    thicknessMix: f32,
    maxStride: f32,
    limit: f32,
    padding: f32,
    padding2: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;
@group(2) @binding(3) var noiseSampler: sampler;

// Output: rgba16float storage texture (filterable + valid write-only storage format)
@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

const PI_HALF: f32 = 1.5707963267948966192313216916398;

// Reconstruye posición view-space desde UV y depth lineal normalizado [0,1]
fn reconstructViewPos(uv: vec2<f32>, linearDepth01: f32) -> vec3<f32> {
    let ndc    = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH   = camera.invProjection * ndc;
    let rayDir = rayH.xyz / rayH.w;
    let viewZ  = -mix(0.1, camera.cameraFar, linearDepth01);
    return rayDir * (viewZ / rayDir.z);
}

fn sampleViewPos(uv: vec2<f32>) -> vec3<f32> {
    let d = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    return reconstructViewPos(uv, d);
}

fn hash1(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn fastAcos(x: f32) -> f32 {
    let ax  = abs(x);
    var res = (-0.156583 * ax + PI_HALF) * sqrt(max(0.0, 1.0 - ax));
    return select(PI - res, res, x >= 0.0);
}

fn integrateArc(h1: f32, h2: f32, n: f32) -> f32 {
    let cosN = cos(n);
    let sinN = sin(n);
    return 0.25 * (
        -cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN +
        -cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN
    );
}

fn findHorizon(
    tcBase    : vec2<f32>,
    aoDir     : vec2<f32>,
    centerPos : vec3<f32>,
    vView     : vec3<f32>,
    stepSign  : f32,
    numSamples: i32,
) -> f32 {
    var maxCos: f32 = -1.0;

    for (var i: i32 = 1; i <= numSamples; i++) {
        let uvS = tcBase + aoDir * (f32(i) * stepSign);

        if (any(uvS < vec2<f32>(0.0)) || any(uvS > vec2<f32>(1.0))) { break; }

        let depthS = textureSampleLevel(gLinearDepth, samplerGBuffer, uvS, 0.0).x;
        if (depthS >= 1.0) { break; }

        let posS = reconstructViewPos(uvS, depthS);
        let diff = posS - centerPos;
        let len  = length(diff);

        if (len < 1e-5) { continue; }
        if (len > params.radius) { continue; }

        let cosHorizon = dot(vView, diff / len);
        let falloff = clamp(1.0 - (len / params.radius), 0.0, 1.0);
        let blended = mix(maxCos, cosHorizon, falloff);

        if (blended > maxCos) {
            maxCos = blended;
            maxCos = mix(maxCos, cosHorizon, params.thicknessMix * (1.0 - falloff));
        }

        if (maxCos > 0.99) { break; }
    }

    return maxCos;
}

fn computeSlice(
    aoDir     : vec2<f32>,
    uv        : vec2<f32>,
    centerPos : vec3<f32>,
    normalVS  : vec3<f32>,
    vView     : vec3<f32>,
    numSamples: i32,
) -> f32 {
    let farUV      = uv + aoDir * 4.0;
    let farPos     = sampleViewPos(farUV);
    let sliceDir3D = normalize(farPos - centerPos);

    let planeN = normalize(cross(vView, sliceDir3D));

    let projNormalRaw = normalVS - planeN * dot(normalVS, planeN);
    let projLen       = length(projNormalRaw);
    if (projLen < 1e-5) { return 1.0; }

    let projNormal = projNormalRaw / projLen;

    let cosN = clamp(dot(projNormal, vView), -1.0, 1.0);
    let n    = fastAcos(cosN) - PI_HALF;

    let h1cos = findHorizon(uv, aoDir, centerPos, vView, -1.0, numSamples);
    let h2cos = findHorizon(uv, aoDir, centerPos, vView,  1.0, numSamples);

    let h1a = -fastAcos(clamp(h1cos, -1.0, 1.0));
    let h2a =  fastAcos(clamp(h2cos, -1.0, 1.0));

    let h1 = n + max(h1a - n, -PI_HALF);
    let h2 = n + min(h2a - n,  PI_HALF);

    let sliceVis = integrateArc(h1, h2, n);
    return mix(1.0, sliceVis, clamp(projLen, 0.0, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(global_id.xy);

    // Bounds check — workgroup may extend beyond the texture boundary
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    // UV at the centre of this AO pixel
    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);

    let linearZ = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    if (linearZ >= 1.0) {
        textureStore(outputAO, coords, vec4<f32>(1.0, 0.0, 0.0, 1.0));
        return;
    }

    let centerPos = reconstructViewPos(uv, linearZ);

    let nData   = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0);
    let nWorld  = octahedral01ToNormal(nData.xy);
    var normalVS = normalize((camera.viewMatrix * vec4<f32>(nWorld, 0.0)).xyz);
    normalVS *= vec3<f32>(-1.0, 1.0, -1.0);

    let vView = normalize(-centerPos);

    let distToCamera = max(-centerPos.z, 0.1);
    let stride = clamp(params.limit / distToCamera, 1.0, params.maxStride);

    let aoRes    = vec2<f32>(dstSize);
    let texelAO  = 1.0 / aoRes;
    let dirScale = texelAO * stride;

    // Jitter — same interleaved 4×4 pattern as the fragment version
    // pos.xy in the fragment shader was in framebuffer space (AO half-res).
    // Here we use global_id.xy directly (same coordinate).
    let fullResPx = vec2<f32>(coords) * 2.0;

    let patternPx  = vec2<u32>(vec2<i32>(fullResPx)) % vec2<u32>(4u, 4u);
    let patternIdx = f32(patternPx.y * 4u + patternPx.x);
    let hashVal    = hash1(fullResPx);

    let sliceCount = i32(params.sliceCount);
    let sliceStep  = TWO_PI / f32(sliceCount);
    let jitter     = (patternIdx + hashVal) / 16.0 * sliceStep;

    var visibility = 0.0;
    let numSamples = i32(params.sampleCount);

    for (var s: i32 = 0; s < sliceCount; s++) {
        let baseAngle  = sliceStep * (f32(s) + 0.5);
        let sliceAngle = baseAngle + jitter;

        let aoDir = dirScale * vec2<f32>(sin(sliceAngle), cos(sliceAngle));

        visibility += computeSlice(aoDir, uv, centerPos, normalVS, vView, numSamples);
    }

    visibility /= f32(sliceCount);

    textureStore(outputAO, coords, vec4<f32>(clamp(pow(visibility, params.aoStrength), 0.0, 1.0), 0.0, 0.0, 1.0));
}
