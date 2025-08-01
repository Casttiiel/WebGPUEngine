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

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let radius = 1.0;
    let step = 0.02;
    let tangentBias = 0.3;
    let aoStrength = 2.0;
    let samplingDirections = 16u;
    let stepCount = 4u;
    let screenSize = camera.screenSize;
    let uvRadius = false;

    // Early out if depth is invalid (e.g. background)
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    //return zRaw;
    if (linearZ >= 1.0) {
        return 0.0;
    }

    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = normalize(decodeNormal(normalData.xyz));
    var normalView = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    normalView *= vec3<f32>(-1.0, 1.0, -1.0); // Necesary to flip Y and Z for correct view space normals
    let viewPosition = getViewPosition(uv);

    let samplingDiskDirection = 2.0 * PI / f32(samplingDirections);
    var sum = 0.0;
    var occlusion = 0.0;

    for (var i = 0u; i < samplingDirections; i = i + 1u) {
        let samplingDirectionAngle = f32(i) * samplingDiskDirection;
        let samplingDirection = vec2<f32>(cos(samplingDirectionAngle), sin(samplingDirectionAngle));

        let tangentAngle = acos(dot(vec3(samplingDirection, 0.0), normalView.xyz)) - (0.5 * PI) + tangentBias;
        var horizonAngle = tangentAngle; //set the horizon angle to the tangent angle to begin with

        var lastDifference = vec3<f32>(0.0);

        for (var j = 0u; j < stepCount; j = j + 1u) {
            var sampleUV: vec2<f32>; 
            if(uvRadius){
                // step forward in the sampling direction
                let stepForward = f32(j+1) * step * samplingDirection;
                // use the stepforward position as an offset from the current fragment position in order to move to that location
                sampleUV = uv + stepForward;
            }else{
                // step forward in the sampling direction
                let stepForward = vec2<f32>(cos(samplingDirectionAngle), sin(samplingDirectionAngle)) * (f32(j + 1) * step);
                // use the stepforward position as an offset from the current fragment position in order to move to that location
                let stepPosition = viewPosition + vec3<f32>(stepForward.x, 0.0, stepForward.y); // desplazamiento en el plano XY (view space) : ESTO ES INCORRECTO!
                sampleUV = projectViewToUV(stepPosition);
            }
            
            let viewSpaceSteppedPosition = getViewPosition(sampleUV);
            
            // Now that we have the view-space position of the offset sample point
            // We can check the distance from our current fragment to the offset point
            let diff = viewSpaceSteppedPosition.xyz - viewPosition;           
            // If the distance is less than the set radius 
            if(length(diff) < radius){
                lastDifference = diff;
                let foundElevationAngle = atan(diff.z / length(diff.xy));
                horizonAngle = max(horizonAngle, foundElevationAngle);
            }
        }

        let norm = length(lastDifference) / radius;
        let attenuation = 1 - norm * norm;

        occlusion = clamp(attenuation * (sin(horizonAngle) - sin(tangentAngle)), 0.0, 1.0);
        sum += 1.0 - occlusion;
    }

    sum /= f32(samplingDirections);
    return sum;
}