/**
 * Per-Object Velocity Fragment Shader
 *
 * Converts the current- and previous-frame clip positions into a UV-space
 * velocity vector (same convention as velocity_buffer.fs) and writes it to
 * the velocity render target.
 *
 * The output overwrites the fullscreen camera-only velocity produced by the
 * preceding velocity_buffer pass with a value that correctly accounts for the
 * object's own movement between frames.
 *
 * UV-space convention (matches velocity_buffer.fs):
 *   positive X → object moved right
 *   positive Y → object moved down
 */

struct VertexOutput {
    @builtin(position) clipPos:         vec4<f32>,
    @location(0)       currentClipPos:  vec4<f32>,
    @location(1)       previousClipPos: vec4<f32>,
}

@fragment
fn fs(in: VertexOutput) -> @location(0) vec4<f32> {
    // NDC in [-1, 1].  Divide by w for perspective-correct positions.
    let currentNDC  = in.currentClipPos.xy  / in.currentClipPos.w;
    let previousNDC = in.previousClipPos.xy / in.previousClipPos.w;

    // NDC difference → UV-space velocity.
    // NDC X goes left→right (same as UV X), but NDC Y goes bottom→top while UV Y
    // goes top→bottom, so flip Y.  Scale by 0.5 to convert NDC [-1,1] → UV [0,1].
    let velocity = (currentNDC - previousNDC) * vec2<f32>(0.5, -0.5);

    return vec4<f32>(velocity.x, velocity.y, 0.0, 0.0);
}
