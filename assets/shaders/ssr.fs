#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/gbuffer"

// Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;  // Self illumination
@group(1) @binding(4) var gAO: texture_2d<f32>;         // Ambient occlusion
@group(1) @binding(5) var samplerGBuffer: sampler;      // Shared sampler

// SSR Parameters
@group(2) @binding(0) var<uniform> ssrParams: SSRUniforms;

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
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let iPosition = position.xy / camera.screenSize;
    
    // Early exit if SSR is disabled
    if (ssrParams.enabled < 0.5) {
        return textureSampleLevel(gAlbedo, samplerGBuffer, iPosition, 0.0);
    }
    
    // Sample G-Buffer
    let albedo = textureSampleLevel(gAlbedo, samplerGBuffer, iPosition, 0.0);
    let normal = textureSampleLevel(gNormals, samplerGBuffer, iPosition, 0.0).xyz * 2.0 - 1.0; // Unpack normal
    let depth = textureSampleLevel(gLinearDepth, samplerGBuffer, iPosition, 0.0).r;
    
    // Sample original color
    let originalColor = albedo;
    
    // Early exit for non-reflective surfaces
    let metallic = albedo.a; // Assuming metallic is stored in alpha
    let roughness = textureSampleLevel(gNormals, samplerGBuffer, iPosition, 0.0).a; // Assuming roughness is in normal alpha
    
    if (metallic < 0.1 || roughness > 0.8) {
        return originalColor;
    }
    
    // Reconstruct world position from depth
    let worldPos = reconstructWorldPosition(iPosition, depth);
    
    // Calculate reflection vector
    let viewDir = normalize(camera.cameraPosition - worldPos);
    let reflectionDir = reflect(-viewDir, normal);
    
    // Perform ray marching in screen space
    let reflectionColor = performScreenSpaceRayMarching(
        worldPos,
        reflectionDir,
        iPosition,
        depth
    );
    
    // Calculate reflection strength based on metallic/roughness
    let reflectionStrength = metallic * (1.0 - roughness) * ssrParams.intensity;
    
    // Return only the reflection contribution (will be composited later)
    let reflectionContribution = reflectionColor.rgb * reflectionStrength;
    return vec4<f32>(reflectionContribution, reflectionColor.a * reflectionStrength);
}

fn reconstructWorldPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    // Convert UV to NDC
    let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
    
    // Transform to world space
    let worldPos4 = camera.invViewProjection * vec4<f32>(ndc, 1.0);
    return worldPos4.xyz / worldPos4.w;
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
    
    var currentPos = startPos;
    var steps = 0;
    
    // Ray marching loop
    for (var i = 0; i < maxSteps; i++) {
        steps = i;
        
        // Advance ray
        currentPos += rayDir * stepSize;
        
        // Project to screen space
        let clipPos = camera.viewMatrix * camera.projectionMatrix * vec4<f32>(currentPos, 1.0);
        
        if (clipPos.w <= 0.0) {
            break; // Behind camera
        }
        
        let ndc = clipPos.xyz / clipPos.w;
        let screenUV = ndc.xy * 0.5 + 0.5;
        
        // Check if ray is outside screen
        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
            break;
        }
        
        // Sample depth at current screen position
        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let currentDepth = ndc.z;
        
        // Check for intersection
        if (currentDepth > sampledDepth && (currentDepth - sampledDepth) < ssrParams.thickness) {
            // Hit! Sample color at this position
            let hitColor = textureSampleLevel(gAlbedo, samplerGBuffer, screenUV, 0.0);
            
            // Fade based on distance and edge proximity
            let distanceFade = 1.0 - (length(currentPos - startPos) / maxDistance);
            let edgeFade = calculateEdgeFade(screenUV);
            let stepFade = 1.0 - (f32(steps) / f32(maxSteps));
            
            let finalFade = distanceFade * edgeFade * stepFade;
            
            return vec4<f32>(hitColor.rgb, finalFade);
        }
        
        // Check max distance
        if (length(currentPos - startPos) > maxDistance) {
            break;
        }
    }
    
    // No hit found
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fadeX = min(uv.x / fadeWidth, (1.0 - uv.x) / fadeWidth);
    let fadeY = min(uv.y / fadeWidth, (1.0 - uv.y) / fadeWidth);
    return min(fadeX, fadeY);
}
