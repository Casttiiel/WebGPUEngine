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
const MAX_RAY_STEPS:    i32 = 32;

// ─── Interleaved Gradient Noise (Jimenez, 2014) ──────────────────────────────
// Temporally varied with camera.time so each rendered frame gets a different
// noise pattern, enabling temporal accumulation / denoising.
fn IGN(pixelCoord: vec2<f32>, sampleIndex: u32) -> f32 {
    // Ruido estático — mismo patrón cada frame, el bilateral lo suaviza
    let p = pixelCoord + f32(sampleIndex) * vec2<f32>(1.6180339887, 2.6180339887);
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// ─── Cosine-weighted hemisphere sampling ─────────────────────────────────────
// PDF = cos(theta)/PI  →  the cosine term in the rendering equation cancels,
// so the estimator simplifies to a plain average of hit radiances.
fn cosineSampleHemisphere(u1: f32, u2: f32) -> vec3<f32> {
    let r     = sqrt(u1);
    let theta = 2.0 * PI * u2;
    let x     = r * cos(theta);
    let z     = r * sin(theta);
    // y = cos(polar angle), already carries the cosine IS weight in the PDF
    return vec3<f32>(x, sqrt(max(0.0, 1.0 - u1)), z);
}

// Transform vector from local hemisphere space (Y up) to world space using normal
fn transformToNormalSpace(localDir: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    var tangent = vec3<f32>(1.0, 0.0, 0.0);
    if (abs(normal.x) > 0.9) {
        tangent = vec3<f32>(0.0, 1.0, 0.0);
    }
    let bitangent = normalize(cross(normal, tangent));
    tangent = normalize(cross(bitangent, normal));
    return localDir.x * tangent + localDir.z * bitangent + localDir.y * normal;
}

// ─── Screen-edge fade ─────────────────────────────────────────────────────────
fn computeScreenEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fx = min(uv.x, 1.0 - uv.x) / fadeWidth;
    let fy = min(uv.y, 1.0 - uv.y) / fadeWidth;
    return saturate(min(fx, fy));
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    let g = decodeGBuffer(uv);

    // Early exit if is skybox
    if (g.zlinear > 0.999) {
        return vec4<f32>(0.0);
    }

    var accumColor  = vec3<f32>(0.0);
    var validSamples = 0u;
    
    // Pixel coordinates for IGN (avoids scaling issues)
    let pixelCoord = uv * camera.screenSize;
    
    for (var sampleIndex = 0u; sampleIndex < NUM_SSGI_SAMPLES; sampleIndex++) {
        // Two independent random numbers per sample via IGN
        let u1 = IGN(pixelCoord, sampleIndex * 2u);
        let u2 = IGN(pixelCoord, sampleIndex * 2u + 1u);

        // Cosine-weighted direction in world space
        let localDir      = cosineSampleHemisphere(u1, u2);
        let hemisphereDir = transformToNormalSpace(localDir, g.normal);
        
        let sampleResult = performScreenSpaceRayMarching(
            g.worldPos,
            hemisphereDir,
            uv,
            g.zlinear
        );
        
        if (sampleResult.a > 0.0) {
            // No cosine factor: with cosine-weighted sampling the estimator
            // simplifies to a plain average (cos/PDF = 1).
            accumColor += sampleResult.rgb * sampleResult.a;
            validSamples++;
        }
    }
    
    if (validSamples > 0u) {
        accumColor /= f32(validSamples);
    }
    
    return vec4<f32>(accumColor, 1.0);
}

fn performScreenSpaceRayMarching(
    startPos:  vec3<f32>,
    rayDir:    vec3<f32>,
    startUV:   vec2<f32>,
    startDepth: f32
) -> vec4<f32> {
    
    let maxDistance = 50.0;

    var currentPos = startPos;
    var stepSize   = 0.08;   // initial world-space step
    
    // Exponential ray march: 32 steps cover the same range as ~300 fixed steps
    // while front-loading precision where it matters most (close contacts).
    for (var i = 0; i < MAX_RAY_STEPS; i++) {
        
        currentPos += rayDir * stepSize;
        stepSize   *= 1.25;   // geometric growth

        let currentDistance = length(currentPos - startPos);
        if (currentDistance > maxDistance) { break; }

        let viewPos = camera.viewMatrix * vec4<f32>(currentPos, 1.0);
        if (viewPos.z > 0.0) { break; }   // ray behind camera
        
        // Project to screen space
        let clipPos  = camera.projectionMatrix * viewPos;
        let ndc      = clipPos.xyz / clipPos.w;        
        var screenUV = ndc.xy * 0.5 + 0.5;
        screenUV.y   = 1.0 - screenUV.y;

        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) { break; }
        
        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let camb2obj     = currentPos - camera.cameraPosition.xyz;
        let currentDepth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
        
        // Adaptive thickness: looser at distance to avoid missing hits with large steps
        let adaptiveThickness = 0.02 + currentDistance * 0.01;
        
        if (currentDepth > sampledDepth && (currentDepth - sampledDepth) < adaptiveThickness) {
            // Direct albedo sample — cheaper than full decodeGBuffer on every hit
            let hitColor = textureSampleLevel(gAlbedo, samplerGBuffer, screenUV, 0.0).rgb;

            // Fade by screen edge and distance
            let screenFade = computeScreenEdgeFade(screenUV);
            let distFade   = 1.0 - saturate(currentDistance / maxDistance);
            return vec4<f32>(hitColor, screenFade * distFade);
        }
    }
    
    return vec4<f32>(0.0);
}
