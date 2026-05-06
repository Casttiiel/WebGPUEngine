#include "common/uniforms"

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
