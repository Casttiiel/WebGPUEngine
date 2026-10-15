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


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// DOF Textures: Original, Near blur, Far blur, CoC
@group(2) @binding(0) var originalTexture: texture_2d<f32>;
@group(2) @binding(1) var nearBlurTexture: texture_2d<f32>;
@group(2) @binding(2) var farBlurTexture: texture_2d<f32>;
@group(2) @binding(3) var cocTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let original = textureSample(originalTexture, samplerGBuffer, uv);
    let nearBlur = textureSample(nearBlurTexture, samplerGBuffer, uv);
    let farBlur = textureSample(farBlurTexture, samplerGBuffer, uv);
    let cocData = textureSample(cocTexture, samplerGBuffer, uv);
    
    let farCoC = cocData.r;   // Background blur amount
    let nearCoC = cocData.g;  // Foreground blur amount
    let fullCoC = cocData.b;  // Signed CoC
    
    var result: vec4<f32>;
    
    // Skybox detection (CoC = 0 siempre)
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    if (linearDepth >= 0.9999) {
        return original; // Skybox siempre sharp
    }
    
    // Decisión de composición basada en CoC
    if (abs(fullCoC) < 0.5) {
        // In focus - usar imagen original
        result = original;
    } else if (fullCoC < 0.0) {
        // Near blur (foreground)
        let blendFactor = smoothstep(0.0, 10.0, nearCoC);
        result = mix(original, nearBlur, blendFactor);
    } else {
        // Far blur (background)
        let blendFactor = smoothstep(0.0, 10.0, farCoC);
        result = mix(original, farBlur, blendFactor);
    }
    
    return result;
}