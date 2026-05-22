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
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gAlbedoSampler: sampler;

const FXAA_EDGE_THRESHOLD : f32 = 1.0 / 8.0;
const FXAA_EDGE_THRESHOLD_MIN : f32 = 1.0 / 24.0;
const FXAA_SUBPIX_TRIM : f32 = 1.0 / 4.0;
const FXAA_SUBPIX_TRIM_SCALE : f32 = 1.0 / (1.0 - FXAA_SUBPIX_TRIM);
const FXAA_SUBPIX_CAP : f32 = 3.0 / 4.0;
const FXAA_JITTER_STRENGTH : f32 = 0.25;

 fn luma(color: vec3<f32>) -> f32 {
        return sqrt(dot(color, vec3(0.299, 0.587, 0.114)));
 };

 // Resolution-dependent threshold calculation
fn calculateEdgeThreshold(resolution: vec2<f32>) -> f32 {
    // Calculate pixels per screen width (medida de densidad de píxeles)
    let pixelDensity = resolution.x;
    
    // Adjust threshold based on pixel density:
    // - Para resoluciones bajas (< 720p): threshold más alto para evitar blur excesivo
    // - Para resoluciones medias: threshold base
    // - Para resoluciones altas (> 2K): threshold más bajo para mejor detección de bordes
    var scaleFactor: f32;
    if (pixelDensity < 1280.0) {
        // Para resoluciones bajas, aumentar threshold
        scaleFactor = 1.25;
    } else if (pixelDensity > 2560.0) {
        // Para resoluciones altas, reducir threshold
        scaleFactor = 0.75;
    } else {
        // Para resoluciones medias, escalar linealmente
        scaleFactor = 1.0 - (pixelDensity - 1280.0) / (2560.0 - 1280.0) * 0.5;
    }
    
    return FXAA_EDGE_THRESHOLD * scaleFactor;
};


// Subpixel jittering function
fn calculateJitterOffset(uv: vec2<f32>) -> vec2<f32> {
    let rand1 = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
    let rand2 = fract(sin(dot(uv, vec2(39.346, 11.135))) * 22578.1459);
    return (vec2(rand1, rand2) - 0.5) * FXAA_JITTER_STRENGTH / camera.screenSize;
};

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rcpFrame = 1.0 / camera.screenSize;
    
    // Calculate dynamic edge threshold based on resolution
    let dynamicEdgeThreshold = calculateEdgeThreshold(camera.screenSize);
    
    // Apply subpixel jittering
    let jitterOffset = calculateJitterOffset(uv);
    let jitteredUV = uv + jitterOffset;

    // === Sample all neighbors with jittered coordinates ===
    let colM = textureSample(gAlbedo, gAlbedoSampler, jitteredUV).rgb;
    let colN = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2(0.0, -rcpFrame.y)).rgb;
    let colS = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2(0.0,  rcpFrame.y)).rgb;
    let colE = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2( rcpFrame.x, 0.0)).rgb;
    let colW = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2(-rcpFrame.x, 0.0)).rgb;

    let colNW = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2(-rcpFrame.x, -rcpFrame.y)).rgb;
    let colNE = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2( rcpFrame.x, -rcpFrame.y)).rgb;
    let colSW = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2(-rcpFrame.x,  rcpFrame.y)).rgb;
    let colSE = textureSample(gAlbedo, gAlbedoSampler, jitteredUV + vec2( rcpFrame.x,  rcpFrame.y)).rgb;

    // === Compute luma values for all samples ===
    let lumaM = luma(colM);
    let lumaN = luma(colN);
    let lumaS = luma(colS);
    let lumaE = luma(colE);
    let lumaW = luma(colW);
    let lumaNW = luma(colNW);
    let lumaNE = luma(colNE);
    let lumaSW = luma(colSW);
    let lumaSE = luma(colSE);

    let rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let range = rangeMax - rangeMin;

    // === Calculate blend amount unconditionally ===
    let lumaAvg = (lumaN + lumaS + lumaE + lumaW) * 0.25;
    let rangeL = abs(lumaAvg - lumaM);
    var blendL = max(0.0, (rangeL / range) - FXAA_SUBPIX_TRIM) * FXAA_SUBPIX_TRIM_SCALE;
    blendL = min(FXAA_SUBPIX_CAP, blendL);

    // === Adaptive edge detection with dynamic threshold ===
    let isEdge = range >= max(FXAA_EDGE_THRESHOLD_MIN, rangeMax * dynamicEdgeThreshold);
    
    // Enhanced subpixel processing
    var finalColor = colM;
    if (isEdge) {
        // Calculate edge direction
        let horizontal = abs(lumaN + lumaS - 2.0 * lumaM) * 2.0 + 
                        abs(lumaNE + lumaSE - 2.0 * lumaE) +
                        abs(lumaNW + lumaSW - 2.0 * lumaW);
        let vertical = abs(lumaE + lumaW - 2.0 * lumaM) * 2.0 +
                      abs(lumaNE + lumaNW - 2.0 * lumaN) +
                      abs(lumaSE + lumaSW - 2.0 * lumaS);
        
        // Determine blend direction
        let isHorizontal = horizontal >= vertical;
        
        // Blend based on edge direction
        if (isHorizontal) {
            finalColor = mix(colM, mix(colE, colW, 0.5), blendL);
        } else {
            finalColor = mix(colM, mix(colN, colS, 0.5), blendL);
        }
    }

    // Remove jitter artifacts
    finalColor = mix(finalColor, colM, length(jitterOffset) * 2.0);

    return vec4<f32>(finalColor, 1.0);
}