#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

// ---------------------------------------------------------------------------
// Grass single-blade vertex shader — non-instanced, ObjectUniforms path.
// Wind displacement applied in world space using position.y as height factor.
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = MaterialTextures  (FS only, not needed here)
// @group(2) = ObjectUniforms    (model matrix from TransformComponent)
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,
) -> VertexOutput {
  // Transform to world space first
  let worldPos4 = object.modelMatrix * vec4<f32>(position, 1.0);
  var worldPos  = worldPos4.xyz;

  // Wind — position.y [0,1] from mesh local space gives height factor.
  // We read it from the raw (pre-transform) vertex position so scale doesn't break it.
  let heightFactor = position.y;
  let windPhase = (worldPos.x * 0.08 + worldPos.z * 0.05) + camera.time * 1.4;
  let windX = sin(windPhase)               * heightFactor * 0.28;
  let windZ = cos(windPhase * 0.73 + 1.3) * heightFactor * 0.14;

  worldPos.x += windX;
  worldPos.z += windZ;

  let model3x3 = get3x3From4x4(object.modelMatrix);

  var output: VertexOutput;
  output.WorldPos = worldPos;
  output.position = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
  output.N        = normalize(model3x3 * normal);
  output.T        = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
  output.Uv       = uv;
  return output;
}
