#include "common/uniforms"
#include "common/structs"
#include "common/core/constants"
#include "common/octahedral"
#include "common/gbuffer"

// Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var samplerGBuffer: sampler;      // Shared sampler


// SSGI Constants
const NUM_SSGI_SAMPLES: u32 = 16u;

// Uses Fibonacci spiral distribution for better coverage
fn getHemisphereSample(index: u32) -> vec3<f32> {
    let i = f32(index);
    let n = f32(NUM_SSGI_SAMPLES);
    
    // Uniform hemisphere distribution by area
    // Option 1: Guaranteed 2PI coverage (uniform distribution)
    let theta = (2.0 * PI * i) / n; // Evenly distributed around 2PI
    let cosTheta = 1.0 - (i / n); // Cosine of polar angle (1 to 0)
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta); // Sine of polar angle
    
    // Option 2: Fibonacci (better distribution but less predictable coverage)
    // let goldenAngle = 2.39996323;
    // let theta = goldenAngle * i;
    
    // Convert to cartesian coordinates (Y up hemisphere)
    let x = cos(theta) * sinTheta;
    let z = sin(theta) * sinTheta;
    let y = cosTheta; // y component (height in hemisphere)
    
    return normalize(vec3<f32>(x, y, z));
}

// Generate hemisphere direction based on surface normal
fn generateHemisphereDirection(normal: vec3<f32>, index: u32, seed: f32) -> vec3<f32> {
    // Get base hemisphere sample (Y up, local space)
    let localSample = getHemisphereSample(index);
    
    // Transform directly to world space using surface normal as up vector
    let worldDir = transformToNormalSpace(localSample, normal);
    
    // Add small random rotation to break patterns (but keep in hemisphere)
    let noise = fract(seed + f32(index) * 0.618);
    let rotationAngle = noise * 0.2; // Small rotation (about 11 degrees max)
    
    // Create rotation around the normal
    let rotAxis = normalize(cross(normal, worldDir));
    if (length(rotAxis) < 0.001) {
        // If cross product is too small, use the direction as-is
        return worldDir;
    }
    
    // Apply small rotation to add variation
    let cosAngle = cos(rotationAngle);
    let sinAngle = sin(rotationAngle);
    let rotatedDir = worldDir * cosAngle + cross(rotAxis, worldDir) * sinAngle;
    
    return normalize(rotatedDir);
}

// Transform vector from local hemisphere space (Y up) to world space using normal
fn transformToNormalSpace(localDir: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    // Create orthonormal basis with normal as Z (up)
    var tangent = vec3<f32>(1.0, 0.0, 0.0);
    if (abs(normal.x) > 0.9) {
        tangent = vec3<f32>(0.0, 1.0, 0.0);
    }
    
    let bitangent = normalize(cross(normal, tangent));
    tangent = normalize(cross(bitangent, normal));
    
    // Transform from local space (Y up) to world space (normal up)
    // localDir.y becomes the component along normal
    // localDir.x and localDir.z become tangent plane components
    return localDir.x * tangent + localDir.z * bitangent + localDir.y * normal;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    let g = decodeGBuffer(uv);

    // Early exit if is skybox
    if (g.zlinear > 0.999) {
        return vec4<f32>(0.0);
    }

    var accumColor = vec3<f32>(0.0);
    var validSamples = 0u;
    
    // Generate seed for this pixel
    let seed = dot(uv, vec2<f32>(12.9898, 78.233)) * 43758.5453;
    
    // Perform multiple ray marching passes for SSGI
    for (var sampleIndex = 0u; sampleIndex < NUM_SSGI_SAMPLES; sampleIndex++) {
        let hemisphereDir = generateHemisphereDirection(g.normal, sampleIndex, seed);
        
        // Calculate cosine weight for Lambert's law (more contribution from rays aligned with normal)
        let cosWeight = max(dot(g.normal, hemisphereDir), 0.0);
        
        let sampleResult = performScreenSpaceRayMarching(
            g.worldPos,
            hemisphereDir,
            uv,
            g.zlinear,
            g
        );
        
        if (sampleResult.a > 0.0) {
            // Apply cosine weighting for physically correct diffuse distribution
            accumColor += sampleResult.rgb * cosWeight;
            validSamples++;
        }
    }
    
    // Average the results
    if (validSamples > 0u) {
        accumColor /= f32(validSamples);
    }
    
    return vec4<f32>(accumColor, 1.0);
}

fn performScreenSpaceRayMarching(
    startPos: vec3<f32>,
    rayDir: vec3<f32>,
    startUV: vec2<f32>,
    startDepth: f32,
    g: GBuffer
) -> vec4<f32> {
    
    let stepSize = 0.05;
    let maxSteps = i32(640.0);
    let maxDistance = 50.0;
    let thickness = 0.03;
    
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
        if ((currentDepth > sampledDepth && (currentDepth - sampledDepth) < thickness) || sampledDepth == 1.0) {
            // Hit! Sample color at this position
            let tempG = decodeGBuffer(screenUV);
            let hitColor = tempG.albedo;
            return vec4<f32>(hitColor.rgb, 1.0);
        }
    }
    
    // No hit found
    return vec4<f32>(0.0);
}
