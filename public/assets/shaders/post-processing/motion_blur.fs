#include "common/uniforms"

// Bind Group 0: Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct MotionBlurParams {
    prevViewProjection: mat4x4<f32>,    // Previous frame VP matrix
    invViewProjection: mat4x4<f32>,     // Current inverse VP matrix
    blurStrength: f32,                   // Blur intensity (0.0 - 1.0)
    numSamples: f32,                     // Number of samples (quality vs performance)
    _padding0: f32,
    _padding1: f32,
}

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// Bind Group 2: Input textures
@group(2) @binding(0) var inputTexture: texture_2d<f32>;  // HDR scene
@group(2) @binding(1) var inputSampler: sampler;
@group(2) @binding(2) var<uniform> motionBlur: MotionBlurParams;

// Fragment input
struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// Reconstruct world position from linear depth
fn reconstructWorldPosition(uv: vec2<f32>, linearDepth: f32) -> vec3<f32> {
    // Convert linear depth (0 to far) to NDC depth (0 to 1)
    // Linear depth is stored as distance from camera in world units
    // We need to convert it back to clip space depth
    let ndcDepth = (linearDepth - 0.1) / (camera.cameraFront.w - 0.1);
    
    // NDC coordinates
    let ndc = vec3<f32>(
        uv.x * 2.0 - 1.0,
        (1.0 - uv.y) * 2.0 - 1.0,
        ndcDepth * 2.0 - 1.0  // Convert [0,1] to [-1,1] for NDC
    );
    
    // Clip space
    let clipSpace = vec4<f32>(ndc, 1.0);
    
    // World space
    let worldSpace = motionBlur.invViewProjection * clipSpace;
    
    return worldSpace.xyz / worldSpace.w;
}

// Calculate velocity vector (current → previous screen position)
fn calculateVelocity(worldPos: vec3<f32>, currentUV: vec2<f32>) -> vec2<f32> {
    // Project world position to previous frame's screen space
    let prevClipSpace = motionBlur.prevViewProjection * vec4<f32>(worldPos, 1.0);
    let prevNDC = prevClipSpace.xyz / prevClipSpace.w;
    
    // Convert to UV space
    let prevUV = vec2<f32>(
        prevNDC.x * 0.5 + 0.5,
        1.0 - (prevNDC.y * 0.5 + 0.5)
    );
    
    // Velocity = difference between current and previous UV
    return currentUV - prevUV;
}

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4<f32> {
    let uv = input.uv;
    
    // Sample linear depth and original color BEFORE any conditionals
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    let originalColor = textureSample(inputTexture, inputSampler, uv).rgb;
    
    // Check if skybox (linear depth near camera.far)
    let isSkybox = linearDepth >= (camera.cameraFront.w - 0.01);
    
    // Reconstruct world position from linear depth
    let worldPos = reconstructWorldPosition(uv, linearDepth);
    
    // Calculate velocity vector
    let velocity = calculateVelocity(worldPos, uv);
    
    // Apply blur strength
    let scaledVelocity = velocity * motionBlur.blurStrength;
    
    // Check if velocity is negligible
    let velocityMagnitude = length(scaledVelocity);
    let hasVelocity = velocityMagnitude >= 0.001;
    
    // Sample along velocity vector
    let numSamples = i32(motionBlur.numSamples);
    var blurredColor = vec3<f32>(0.0);
    var totalWeight = 0.0;
    
    for (var i = 0; i < numSamples; i++) {
        // Distribute samples along velocity vector
        let t = f32(i) / f32(numSamples - 1) - 0.5; // -0.5 to 0.5
        let sampleUV = uv + scaledVelocity * t;
        
        // Clamp to valid UV range
        let clampedUV = clamp(sampleUV, vec2<f32>(0.0), vec2<f32>(1.0));
        
        // Weight samples (center samples have more weight)
        let weight = 1.0 - abs(t * 2.0); // Triangular weight
        
        // Sample texture
        let sampleColor = textureSample(inputTexture, inputSampler, clampedUV).rgb;
        
        blurredColor += sampleColor * weight;
        totalWeight += weight;
    }
    
    // Normalize blurred color
    blurredColor /= totalWeight;
    
    // Use select() to choose final color without early returns
    // If skybox or no velocity, use original; otherwise use blurred
    let shouldBlur = hasVelocity && !isSkybox;
    let finalColor = select(originalColor, blurredColor, shouldBlur);
    
    return vec4<f32>(finalColor, 1.0);
}
