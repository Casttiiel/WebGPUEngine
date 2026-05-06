#include "common/uniforms"

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
