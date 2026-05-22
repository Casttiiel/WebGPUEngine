struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}


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
    let ndcDepth = (linearDepth - 0.1) / (camera.cameraFar - 0.1);
    
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
    let isSkybox = linearDepth >= (camera.cameraFar - 0.01);
    
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
