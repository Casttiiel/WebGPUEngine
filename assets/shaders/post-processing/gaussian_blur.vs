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


struct GaussianBlurUniforms {
    blur_w: vec4<f32>, 
    blur_d: vec3<f32>, 
    global_distance: f32,
    direction: vec2<f32>,
}

// Vertex shader inputs/outputs
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) offset1: vec4<f32>,  // xy: +offset1, zw: -offset1
    @location(2) offset2: vec4<f32>,  // xy: +offset2, zw: -offset2
    @location(3) offset3: vec4<f32>,  // xy: +offset3, zw: -offset3
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> blurParams: GaussianBlurUniforms;

@vertex
fn vs(@location(0) position: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Convert to NDC space
    output.position = vec4<f32>(position * 2.0 - 1.0, 0.0, 1.0);
    output.uv = position;

    let uv = position; // Use position directly as UV
    
    // Create temporary variables for all offsets
    let offset1Plus = uv + blurParams.direction * blurParams.blur_d.x;
    let offset1Minus = uv - blurParams.direction * blurParams.blur_d.x;
    let offset2Plus = uv + blurParams.direction * blurParams.blur_d.y;
    let offset2Minus = uv - blurParams.direction * blurParams.blur_d.y;
    let offset3Plus = uv + blurParams.direction * blurParams.blur_d.z;
    let offset3Minus = uv - blurParams.direction * blurParams.blur_d.z;
    
    // Assign the complete vectors at once (not component-wise)
    output.offset1 = vec4<f32>(offset1Plus.x, offset1Plus.y, offset1Minus.x, offset1Minus.y);
    output.offset2 = vec4<f32>(offset2Plus.x, offset2Plus.y, offset2Minus.x, offset2Minus.y);
    output.offset3 = vec4<f32>(offset3Plus.x, offset3Plus.y, offset3Minus.x, offset3Minus.y);
    
    return output;
}
