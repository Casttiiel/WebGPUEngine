#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    aoStrength: f32,
    noiseScale: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;

const PI_HALF: f32 = 1.5707963267948966192313216916398;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let angleBias = 0.05;
    let thickness = 0.05;
    // Sample the linear depth to discard background
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    if (linearZ >= 1.0) {
        discard;
    }

    let P = getViewPosition(uv);
    
    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = octahedral01ToNormal(normalData.xy);
    var viewNormal = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    viewNormal *= vec3<f32>(-1.0, 1.0, -1.0);

    // basis aligned to surface
    let basis = makeTangentBasis(viewNormal);

    // random rotation to decorrelate slices
    let rot = hash12(uv * ssaoParams.noiseScale) * 2.0 * PI;

    let slices = i32(ssaoParams.sampleCount);
    let steps  = i32(12);

    var occlSum : f32 = 0.0;
    var weightSum : f32 = 0.0;
    var prevSliceOcc: f32 = 0.0;

    // for each slice (direction around the hemisphere)
    for (var si: i32 = 0; si < slices; si = si + 1) {
        let a = (f32(si) / f32(slices)) * 2.0 * PI + rot;
        let dir2D = vec2<f32>(cos(a), sin(a));
        var maxAngle : f32 = -1e6;

        // sample along slice (from near -> far)
        for (var ti: i32 = 0; ti < steps; ti = ti + 1) {
            let ustep = ((f32(ti) + 0.5 ) / f32(steps));
            let distFactor = ustep * ustep; // quadratic
            // offset in tangent space (disk), Z=0 -> no normal offset (samples lie on surface plane)
            let offsetT = vec3<f32>(dir2D * (distFactor * ssaoParams.radius), 0.0);
            // transform to view-space and get sample position
            let sampleVS = P + basis * offsetT;

            // project to UV
            let sampleUV = projectToUV(sampleVS);
            // skip if outside
            if (any(sampleUV < vec2<f32>(0.0)) || any(sampleUV > vec2<f32>(1.0))) { continue; }

            // fetch sample view pos
            let PS = getViewPosition(sampleUV);

            // thickness check to avoid leaking across thin geometry
            if (PS.z > P.z + thickness) { continue; }

            let v = PS - P;
            let planar = length(v - dot(v, viewNormal) * viewNormal) + 1e-4;
            // dz: center.z - sample.z (view-space z, camera looking -Z convention is OK)
            let dz = P.z - PS.z;
            let angle = atan2(dz, planar + 1e-6);
            let biased = angle - angleBias;
            if (biased > maxAngle) {
                maxAngle = biased;
            }
        } // steps loop

        if (maxAngle > -1e5) {
            // map to 0..1 (pi/2 -> 1)
            var sliceOcc = saturate(maxAngle / (0.5 * PI));
            // weight by alignment between slice direction (in view-space) and normal
            let sliceDirVS = normalize(basis * vec3<f32>(dir2D, 0.0));
            let nDot = saturate(dot(viewNormal, sliceDirVS) * 0.5 + 0.5); // remap [-1,1] -> [0,1]
            sliceOcc = sliceOcc * nDot;
            occlSum = occlSum + sliceOcc;
            weightSum = weightSum + 1.0;
        }
    } // slices


    if (weightSum <= 0.0) { return 1.0; }
    var aoRaw = occlSum / weightSum;        // 0..1 where 1 = full occlusion
    aoRaw = saturate(aoRaw * ssaoParams.aoStrength);
    // final AO: 1 means unoccluded (white), 0 fully occluded (black)
    return saturate(1.0 - aoRaw);
}

fn getViewZ(linearDepth: f32) -> f32 {
    return mix(0.1, 1000.0, linearDepth);
}

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0); // z = 1.0 at the far plane
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getViewPosition(uv: vec2<f32>) -> vec3<f32> {
    let zLinear = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewZ = getViewZ(zLinear);
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * -viewZ;
}

// Build tangent basis (tangent, bitangent, normal) in view-space
fn makeTangentBasis(n: vec3<f32>) -> mat3x3<f32> {
    // choose arbitrary up that is not parallel to n
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    return mat3x3<f32>(tangent, bitangent, n);
}

// small hash -> [0,1)
fn hash12(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

// project view-space position to UV (0..1) using projection matrix
fn projectToUV(posVS: vec3<f32>) -> vec2<f32> {
    let clip = camera.projectionMatrix * vec4<f32>(posVS, 1.0);
    let ndc = clip.xyz / clip.w;
    return ndc.xy * 0.5 + vec2<f32>(0.5, 0.5);
}