#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

// Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var samplerGBuffer: sampler;      // Shared sampler

// SSR Parameters
@group(2) @binding(0) var accLight: texture_2d<f32>;
@group(2) @binding(1) var accLightSampler: sampler;
@group(2) @binding(2) var<uniform> ssrParams: SSRUniforms;


struct SSRUniforms {
    intensity: f32,
    stepSize: f32,
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    padding1: f32,
    padding2: f32,
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    // Early exit if SSR is disabled
    if (ssrParams.enabled < 0.5) {
        return vec4<f32>(0.0);//FALLBACK
    }
    
    let g = decodeGBuffer(uv);

    if (g.metallic < 0.1 || g.roughness > 0.8) {
        return vec4<f32>(0.0);//FALLBACK
    }
    
    // Perform ray marching in screen space
    let reflectionColor = performScreenSpaceRayMarching(
        g.worldPos,
        g.reflectedDir,
        uv,
        g.zlinear
    );

    // Calculate reflection strength based on metallic/roughness
    let reflectionStrength = g.metallic * (1.0 - g.roughness) * ssrParams.intensity;
    
    // Return only the reflection contribution (will be composited later)
    let reflectionContribution = reflectionColor.rgb * reflectionStrength;
    return vec4<f32>(reflectionContribution, reflectionColor.a * reflectionStrength);
}


fn performScreenSpaceRayMarching(
    startPos: vec3<f32>,
    rayDir: vec3<f32>,
    startUV: vec2<f32>,
    startDepth: f32
) -> vec4<f32> {
    
    let stepSize = ssrParams.stepSize;
    let maxSteps = i32(ssrParams.maxSteps);
    let maxDistance = ssrParams.maxDistance;
    let thickness = ssrParams.thickness;
    
    var currentPos = startPos;
    
    // Ray marching loop
    for (var i = 0; i < maxSteps; i++) {
        
        // Advance ray
        currentPos += rayDir * stepSize;

        let currentDistance = length(currentPos - startPos);
        if (currentDistance > maxDistance) {
            break; // Early exit - save GPU cycles
        }

        let viewPos = camera.viewMatrix * vec4<f32>(currentPos, 1.0);
        
        if (viewPos.z > 0.0) {
            break;
        }
        
        // Project to screen space
        let clipPos = camera.projectionMatrix * viewPos;
        let ndc = clipPos.xyz / clipPos.w;        
        var screenUV = ndc.xy * 0.5 + 0.5;
        screenUV.y = 1.0 - screenUV.y;

        // Check if ray is outside screen
        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
            break;
        }
        
        // Sample depth at current screen position
        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let camb2obj = currentPos - camera.cameraPosition;
        let currentDepth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
        
        // Check for intersection
        if ((currentDepth > sampledDepth && (currentDepth - sampledDepth) < ssrParams.thickness) || sampledDepth == 1.0) {
            // Hit! Sample color at this position
            let hitColor = textureSampleLevel(accLight, accLightSampler, screenUV, 0.0);
            
            // Fade based on distance and edge proximity
            let distanceFade = 1.0 - (currentDistance / maxDistance);
            let edgeFade = calculateEdgeFade(screenUV);
            let stepFade = 1.0 - (f32(i) / f32(maxSteps));
            let finalFade = clamp(distanceFade * edgeFade * stepFade, 0.0, 1.0);
            
            return vec4<f32>(hitColor.rgb, finalFade);
        }
    }
    
    // No hit found
    return vec4<f32>(0.0);//FALLBACK
}

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fadeX = min(uv.x / fadeWidth, (1.0 - uv.x) / fadeWidth);
    let fadeY = min(uv.y / fadeWidth, (1.0 - uv.y) / fadeWidth);
    return min(fadeX, fadeY);
}
