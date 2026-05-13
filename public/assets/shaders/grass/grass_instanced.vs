#include "common/uniforms"
#include "common/structs"

// ---------------------------------------------------------------------------
// Grass instanced vertex shader — GPU storage buffer path.
// Per-instance data comes from a GrassInstance storage buffer at @group(2).
// Wind displacement uses raw position.y (mesh local space, always [0,1]) as
// the height factor so scale doesn't affect wind amplitude.
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = MaterialTextures  (FS only — not declared here)
// @group(2) = InstanceStorage   (array<GrassInstance>)
// ---------------------------------------------------------------------------

struct GrassInstance {
  pos:      vec3<f32>,   // offset  0, size 12 — vec3 alignment=16 → next at 16
  seed:     f32,         // offset 16
  rotation: f32,         // offset 20
  scale:    f32,         // offset 24
  _pad:     vec2<f32>,   // offset 28 (8 bytes) — struct total padded to 48 for array stride
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<storage, read> instances: array<GrassInstance>;

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,
  @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
  let inst = instances[instanceIdx];

  // 1. Uniform scale — width and height both respond to inst.scale
  let scaledPos = position * inst.scale;

  // 2. Y-axis rotation
  let cosR = cos(inst.rotation);
  let sinR = sin(inst.rotation);
  let rotatedPos = vec3<f32>(
    scaledPos.x * cosR - scaledPos.z * sinR,
    scaledPos.y,
    scaledPos.x * sinR + scaledPos.z * cosR,
  );

  // 3. Wind — must use raw position.y (pre-scale) so amplitude is consistent
  let heightFactor = position.y; // [0,1] from mesh local space
  let windPhase = (inst.pos.x * 0.08 + inst.pos.z * 0.05) + camera.time * 1.4;
  let windX = sin(windPhase)               * heightFactor * 0.28;
  let windZ = cos(windPhase * 0.73 + 1.3) * heightFactor * 0.14;

  // 4. World position
  let worldPos = vec3<f32>(
    inst.pos.x + rotatedPos.x + windX,
    inst.pos.y + rotatedPos.y,
    inst.pos.z + rotatedPos.z + windZ,
  );

  var output: VertexOutput;
  output.WorldPos = worldPos;
  output.position = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
  output.N  = normal;
  output.T  = vec4<f32>(1.0, 0.0, 0.0, inst.seed); // seed packed in T.w for FS tint
  output.Uv = uv;
  return output;
}
