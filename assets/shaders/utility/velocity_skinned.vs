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
 * Skinned Per-Object Velocity Vertex Shader
 *
 * Computes screen-space velocity for animated (skinned) geometry by applying
 * the CURRENT bone palette to the vertex for the current clip position, and
 * the PREVIOUS bone palette to the same vertex for last frame's clip position.
 *
 * This correctly handles both:
 *   - Root motion (position/rotation from TransformComponent world matrices)
 *   - Bone animation (per-vertex deformation from the joint palettes)
 *
 * Bind groups:
 *   @group(0)  CameraUniforms   — current camera (unjitteredProjectionMatrix + viewMatrix)
 *   @group(1)  previousVP       — previous-frame unjittered ViewProjection (BufferUniform)
 *   @group(2)  ObjectUniforms   — current + previous world matrices (root motion)
 *   @group(3)  currentJoints    — current-frame joint palette (SkinMatrices)
 *   @group(4)  previousJoints   — previous-frame joint palette (SkinMatrices)
 */

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> previousVP: mat4x4<f32>;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
// Both joint palettes in one group (WebGPU limit: max 4 bind groups).
// binding(0) = current-frame joint palette, binding(1) = previous-frame joint palette.
@group(3) @binding(0) var<storage, read> currentJoints:  array<mat4x4<f32>>;
@group(3) @binding(1) var<storage, read> previousJoints: array<mat4x4<f32>>;

struct VertexOutput {
    @builtin(position) clipPos:         vec4<f32>,
    @location(0)       currentClipPos:  vec4<f32>,
    @location(1)       previousClipPos: vec4<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    // locations 1-3 (normal, uv, tangent) are unused — velocity only needs position
    @location(1) normal:  vec3<f32>,
    @location(2) uv:      vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) joints:  vec4<u32>,
    @location(5) weights: vec4<f32>,
) -> VertexOutput {
    var out: VertexOutput;

    // ── Current frame ─────────────────────────────────────────────────────
    var skinCurrent = mat4x4<f32>(
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0)
    );
    skinCurrent += weights.x * currentJoints[joints.x];
    skinCurrent += weights.y * currentJoints[joints.y];
    skinCurrent += weights.z * currentJoints[joints.z];
    skinCurrent += weights.w * currentJoints[joints.w];

    let worldPosCurrent = object.modelMatrix * skinCurrent * vec4<f32>(position, 1.0);
    let currentVP       = camera.unjitteredProjectionMatrix * camera.viewMatrix;
    let currentClip     = currentVP * worldPosCurrent;

    // ── Previous frame ────────────────────────────────────────────────────
    var skinPrevious = mat4x4<f32>(
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0)
    );
    skinPrevious += weights.x * previousJoints[joints.x];
    skinPrevious += weights.y * previousJoints[joints.y];
    skinPrevious += weights.z * previousJoints[joints.z];
    skinPrevious += weights.w * previousJoints[joints.w];

    let worldPosPrevious = object.previousModelMatrix * skinPrevious * vec4<f32>(position, 1.0);
    let previousClip     = previousVP * worldPosPrevious;

    out.clipPos         = currentClip;
    out.currentClipPos  = currentClip;
    out.previousClipPos = previousClip;
    return out;
}
