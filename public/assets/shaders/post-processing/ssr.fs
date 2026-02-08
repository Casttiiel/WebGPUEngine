#include "common/uniforms"
#include "common/structs"
#include "common/pbr/core"
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
@group(2) @binding(1) var aoTexture: texture_2d<f32>;
@group(2) @binding(2) var brdfLUT: texture_2d<f32>;
@group(2) @binding(3) var texSampler: sampler;
@group(2) @binding(4) var<uniform> ssrParams: SSRUniforms;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    let g = decodeGBuffer(uv);

    // Early exit if SSR is disabled
    if (ssrParams.enabled < 0.5 || g.metallic < 0.1 || g.roughness > 0.9) {
        return vec4<f32>(0.0);
    }
    
    // Perform ray marching in screen space
    let reflectionColor = performScreenSpaceRayMarching(
        g.worldPos,
        g.reflectedDir,
        uv,
        g.zlinear,
        g
    );

    let reflectionContribution = applyFresnelBRDF(reflectionColor.rgb, g);
    return vec4<f32>(reflectionContribution, reflectionColor.a);
}

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);    
    let NdotV = max(dot(N, V), 0.0);
    let F0 = g.specularColor;
    let F = Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdotV, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    return color * (F * brdf.x + brdf.y);
}

fn performScreenSpaceRayMarching(
    startPos: vec3<f32>,
    rayDir: vec3<f32>,
    startUV: vec2<f32>,
    startDepth: f32,
    g: GBuffer
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
        let camb2obj = currentPos - camera.cameraPosition.xyz;
        let currentDepth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFront.w;
        
        // Check for intersection
        if ((currentDepth > sampledDepth && (currentDepth - sampledDepth) < ssrParams.thickness) && sampledDepth > startDepth) {
            // Hit! Sample color at this position
            let hitColor = textureSampleLevel(accLight, texSampler, screenUV, 0.0);
            
            // Fade based on distance and edge proximity
            let distanceFade = 1.0 - (currentDistance / maxDistance);
            let edgeFade = calculateEdgeFade(screenUV);
            let stepFade = 1.0 - (f32(i) / f32(maxSteps));
            let finalFade = clamp(distanceFade * edgeFade * stepFade, 0.0, 1.0);
            
            return vec4<f32>(hitColor.rgb, finalFade);
        }
    }
    
    // No hit found
    return vec4<f32>(0.0);
}

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fadeX = min(uv.x / fadeWidth, (1.0 - uv.x) / fadeWidth);
    let fadeY = min(uv.y / fadeWidth, (1.0 - uv.y) / fadeWidth);
    return min(fadeX, fadeY);
}
