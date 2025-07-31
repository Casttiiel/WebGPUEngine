#include "common/uniforms"
#include "common/utils"

struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    bias: f32,
    aoStrength: f32,
    maxDistance: f32,
    occScale: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;

const PI: f32 = 3.14159265359;

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0); // z = 1.0 at the far plane
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getViewPosition(uv: vec2<f32>) -> vec3<f32> {
    let z = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * -z; // Negative because camera looks down -Z
}

fn computeTanAngle(viewDelta: vec3<f32>) -> f32 {
    return -(viewDelta.z) / length(viewDelta.xy);
}

fn sinFromTan(x: f32) -> f32 {
    return x / sqrt(1.0 + x * x);
}

fn cosineSampleHemisphere(xi: vec2<f32>) -> vec3<f32> {
    let r = sqrt(xi.x);
    let theta = 2.0 * PI * xi.y;
    let x = r * cos(theta);
    let y = r * sin(theta);
    let z = sqrt(max(0.0, 1.0 - x * x - y * y));
    return vec3<f32>(x, y, z);
}

fn getUVFromView(pos: vec3<f32>) -> vec2<f32> {
    let clip = camera.projectionMatrix * vec4<f32>(pos, 1.0);
    let ndc = clip.xy / clip.w;
    return ndc * 0.5 + vec2<f32>(0.5);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let radius = ssaoParams.radius;
    let bias = ssaoParams.bias;
    let aoStrength = ssaoParams.aoStrength;
    let stepCount = 8u;
    let directionCount = ssaoParams.sampleCount;
    let screenSize = camera.screenSize;
    let maxDist = 1000.0;//ssaoParams.maxDistance;

    // Early out if depth is invalid (e.g. background)
    let zRaw = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    //return zRaw;
    if (zRaw >= 1.0) {
        return 0.0;
    }

    let centerPos = getViewPosition(uv);

    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = normalize(decodeNormal(normalData.xyz));
    var normalView = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    normalView *= vec3<f32>(-1.0, 1.0, -1.0); // Necesary to flip Y and Z for correct view space normals

    var upVec = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(normalView, upVec)) > 0.99) {
        upVec = vec3<f32>(1.0, 0.0, 0.0); // Evitar degeneración en superficies verticales
    }
    let tangent = normalize(cross(upVec, normalView));
    let bitangent = cross(normalView, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, normalView); // Tangente en columnas

    // === Radial sample setup ===
    let angleStep = 2.0 * PI / f32(directionCount);
    var occlusion = 0.0;

    for (var d = 0u; d < directionCount; d = d + 1u) {
        let angle = f32(d) * angleStep;
        let dir = vec2<f32>(cos(angle), sin(angle));

        for (var j = 1u; j <= stepCount; j = j + 1u) {
            let scale = f32(j) / f32(stepCount);
            let offset = dir * radius * scale;
            let sampleOffset = TBN * vec3<f32>(offset, 0.0);
            let samplePos = centerPos + sampleOffset;

            let sampleUV = getUVFromView(samplePos);
            if (all(sampleUV >= vec2<f32>(0.0)) && all(sampleUV <= vec2<f32>(1.0))) {
                let sampleZ = textureSampleLevel(gLinearDepth, hbaoSampler, sampleUV, 0.0).x;
                let sampleViewRay = computeViewRayFromUV(sampleUV);
                let sampleViewPos = sampleViewRay * -sampleZ;

                let viewDelta = sampleViewPos - centerPos;
                if (length(viewDelta) < maxDist) {
                    let tanAngle = computeTanAngle(viewDelta);
                    let sinAngle = sinFromTan(tanAngle);
                    if (tanAngle > bias) {
                        occlusion += sinAngle;
                    }
                }
            }
        }
    }

    let totalSamples = f32(directionCount * stepCount);
    let ao = 1.0 - (occlusion / totalSamples) * aoStrength;
    return clamp(ao, 0.0, 1.0);
}