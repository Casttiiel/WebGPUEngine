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


/**
 * Per-Object Velocity Vertex Shader
 *
 * Outputs BOTH the current-frame and previous-frame clip positions for each
 * vertex so the fragment shader can compute the exact screen-space velocity
 * including the object's own motion (not just camera motion).
 *
 * Bind groups:
 *   @group(0)  CameraUniforms   — current camera (unjitteredProjectionMatrix + viewMatrix)
 *   @group(1)  previousVP       — previous-frame unjittered ViewProjection (BufferUniform)
 *   @group(2)  ObjectUniforms   — current + previous world matrices
 */

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> previousVP: mat4x4<f32>;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexOutput {
    @builtin(position) clipPos:         vec4<f32>,
    @location(0)       currentClipPos:  vec4<f32>,
    @location(1)       previousClipPos: vec4<f32>,
}

@vertex
fn vs(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;

    // Current frame: unjittered VP so the velocity doesn't encode sub-pixel jitter.
    // camera.viewMatrix is the pure view (no jitter); only the projection is jittered.
    let currentVP   = camera.unjitteredProjectionMatrix * camera.viewMatrix;
    let currentClip = currentVP * object.modelMatrix * vec4<f32>(position, 1.0);

    // Previous frame: both the camera VP AND the object model matrix from last frame.
    let previousClip = previousVP * object.previousModelMatrix * vec4<f32>(position, 1.0);

    out.clipPos         = currentClip;
    out.currentClipPos  = currentClip;
    out.previousClipPos = previousClip;
    return out;
}
