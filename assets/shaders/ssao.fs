#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

// Estructura para parámetros SSAO solamente
struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    aoStrength: f32,
    noiseScale: f32,
}

// Pre-computed Poisson disk samples para mejor distribución
const POISSON_SAMPLES: array<vec3<f32>, 32> = array<vec3<f32>, 32>(
    vec3<f32>( 0.2335,  0.1312,  0.2264),
    vec3<f32>(-0.1987, -0.0190,  0.0565),
    vec3<f32>(-0.0304,  0.2936,  0.3193),
    vec3<f32>(-0.1176, -0.3054,  0.2731),
    vec3<f32>( 0.2369, -0.1882,  0.5412),
    vec3<f32>( 0.1803,  0.3640,  0.6423),
    vec3<f32>(-0.4218,  0.0733,  0.4190),
    vec3<f32>( 0.4171, -0.0650,  0.8055),
    vec3<f32>(-0.4512,  0.3793,  0.8382),
    vec3<f32>( 0.3905, -0.3225,  0.9423),
    vec3<f32>(-0.5750, -0.1124,  0.7492),
    vec3<f32>( 0.0968,  0.6903,  0.8476),
    vec3<f32>(-0.6220,  0.2358,  0.8531),
    vec3<f32>( 0.6155,  0.1357,  0.9303),
    vec3<f32>(-0.2174, -0.6280,  0.8432),
    vec3<f32>( 0.3497,  0.5201,  0.9911),
    vec3<f32>(-0.7253,  0.1122,  0.9325),
    vec3<f32>( 0.7831, -0.0213,  0.9291),
    vec3<f32>(-0.8124, -0.1942,  0.9732),
    vec3<f32>( 0.2435,  0.7343,  0.8941),
    vec3<f32>(-0.1123, -0.7966,  0.9120),
    vec3<f32>( 0.7648,  0.1924,  0.9541),
    vec3<f32>(-0.5473,  0.5930,  0.9612),
    vec3<f32>( 0.0372, -0.8891,  0.9972),
    vec3<f32>( 0.6354, -0.5513,  0.9865),
    vec3<f32>(-0.8712, -0.1234,  0.9944),
    vec3<f32>( 0.4751,  0.7330,  0.9789),
    vec3<f32>(-0.4020, -0.7602,  0.9731),
    vec3<f32>( 0.6899, -0.6822,  0.9914),
    vec3<f32>(-0.8120,  0.4751,  0.9991),
    vec3<f32>( 0.2183, -0.9217,  0.9893),
    vec3<f32>(-0.5394,  0.8301,  0.9973)
);

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0); // z = 1.0 at the far plane
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getViewPosition(uv: vec2<f32>) -> vec3<f32> {
    let z = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * z; // Negative because camera looks down -Z
}

fn getViewZ(linearDepth: f32) -> f32 {
    return mix(0.1, 1000.0, linearDepth);
}

fn getViewPosition2(uv: vec2<f32>) -> vec3<f32> {
    let zLinear = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewZ = getViewZ(zLinear);
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * viewZ;
}


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let samplingDirections = ssaoParams.sampleCount;
    let aoStrength = ssaoParams.aoStrength;
    let radius = ssaoParams.radius;
    let noiseScale = ssaoParams.noiseScale;
    
    // Sample the linear depth to discard background
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    if (linearZ >= 1.0) {
        discard;
    }

    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = octahedral01ToNormal(normalData.xy);
    var viewNormal = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    viewNormal *= vec3<f32>(1.0, -1.0, 1.0);

    let viewPosition = getViewPosition2(uv);

    var randomVec = textureSampleLevel(noiseTexture, samplerGBuffer, uv * noiseScale, 0).rgb * 2.0 - 1.0;
    randomVec.z = 0.0; // Ensure the random vector is in the XY plane
    randomVec = normalize(randomVec); // Normalize the random vector

    //TBN
    let viewTangent = normalize(randomVec - viewNormal * dot(randomVec, viewNormal));
    let viewBitangent = cross(viewNormal, viewTangent);
    let TBN = mat3x3f(viewTangent, viewBitangent, viewNormal);

    var occlusion = 0.0;
    for (var i = 0u; i < samplingDirections; i = i + 1u) {
        var viewSamplePos = TBN * POISSON_SAMPLES[i].xyz;
        viewSamplePos = viewSamplePos * radius + viewPosition;

        let viewSampleDir = normalize(viewSamplePos - viewPosition);
        let NdotS = max(dot(viewNormal, viewSampleDir), 0.0);

        let clipPos = camera.projectionMatrix * vec4f(viewSamplePos, 1.0);
        let ndcPos = clipPos.xy / clipPos.w;

        let screenCoord = vec2<f32>(ndcPos.x * 0.5 + 0.5, ndcPos.y * 0.5 + 0.5);

        var sampleDepth = getViewPosition2(screenCoord).z;
        let rangeCheck = smoothstep(0.0, 1.0, radius / abs(viewPosition.z - sampleDepth));

        occlusion += select(0.0, 1.0, sampleDepth >= viewSamplePos.z) * rangeCheck * pow(NdotS, 2.0);
    }

    occlusion = 1 - (occlusion / f32(samplingDirections));
    let finalOcclusion = pow(occlusion, aoStrength);

    return finalOcclusion;
}