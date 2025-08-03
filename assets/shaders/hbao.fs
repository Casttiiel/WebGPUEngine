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

fn projectViewToUV(viewPos: vec3<f32>) -> vec2<f32> {
    let clip = camera.projectionMatrix * vec4<f32>(viewPos, 1.0);
    let ndc = clip.xy / clip.w;
    return ndc * 0.5 + vec2<f32>(0.5);
}

// Construir TBN robusto en view space
fn computeTBN2(normal: vec3<f32>) -> mat3x3<f32> {
    let n = normalize(normal);
    let sign = select(1.0, -1.0, n.z < 0.0);
    let a = -1.0 / (sign + n.z);
    let b = n.x * n.y * a;

    let tangent = normalize(vec3<f32>(1.0 + sign * n.x * n.x * a, sign * b, -sign * n.x));
    let bitangent = normalize(vec3<f32>(b, sign + n.y * n.y * a, -n.y));

    return mat3x3<f32>(tangent, bitangent, n);
}

//HBAO Fragment Shader
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let radius = 1.0;
    let step = ssaoParams.radius;
    let tangentBias = ssaoParams.bias;
    let samplingDirections = ssaoParams.sampleCount;
    let stepCount = 8u;
    let aoStrength = ssaoParams.aoStrength;
    let maxDistance = ssaoParams.maxDistance;
    let resolution = camera.screenSize;
    let texelSize = 1.0 / resolution;

    // Sample the linear depth to discard background
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    if (linearZ >= 1.0) {
        return 0.0;
    }

    // Reconstruct normal from G-buffer and convert to view space
    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = normalize(decodeNormal(normalData.xyz));
    var normalView = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    normalView *= vec3<f32>(-1.0, 1.0, -1.0); // Flip Y and Z to convert to left-handed view space

    let viewPosition = getViewPosition(uv);

    // Build tangent space in view space
    let TBN = computeTBN2(normalView);

    let samplingDiskDirection = 2.0 * PI / f32(samplingDirections);
    var sum = 0.0;

    // Loop over directions in tangent plane
    for (var i = 0u; i < samplingDirections; i = i + 1u) {
        let samplingDirectionAngle = f32(i) * samplingDiskDirection;
        let samplingDirection = vec2<f32>(
            cos(samplingDirectionAngle),
            sin(samplingDirectionAngle),
        );

        // Calculate initial tangent angle
        let tangentAngle = atan(-normalView.z / length(normalView.xy)) + tangentBias;
        var maxElevation = tangentAngle;
        var r = 0.0;

        for (var j = 0u; j < stepCount; j = j + 1u) {
            let stepOffsetVS = TBN * vec3<f32>(samplingDirection * (f32(j + 1) * step), 0.0);
            let sampleVS = viewPosition + stepOffsetVS;

            let snappedUV = projectViewToUV(sampleVS);
            let viewSample = getViewPosition(snappedUV);
            let delta = viewSample - viewPosition;

            if (length(delta) > radius) { continue; }

            r = length(delta);
            let elev = atan(-delta.z / length(delta.xy));
            maxElevation = max(maxElevation, elev);
        }

        let weight = max(0.0, 1.0 - r / radius);
        let contribution = (sin(maxElevation) - sin(tangentAngle)) * weight;

        let occlusion = clamp(contribution, 0.0, 1.0);
        sum += 1.0 - occlusion;
    }

    sum /= f32(samplingDirections);
    return pow(sum, aoStrength);
}