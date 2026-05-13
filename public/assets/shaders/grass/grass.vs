#include "common/uniforms"
#include "common/structs"

// ---------------------------------------------------------------------------
// Grass vertex shader — instanced cross-blade placement
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms  (per-frame camera data, incl. time)
// @group(1) = material slots  (grass albedo texture + sampler — FS only, not declared here)
// @group(2) = GrassInstance storage buffer (one entry per blade)
//
// Per-instance data layout (matches GrassVolumeComponent TS side):
//   float[0] = posX      world-space X of blade base
//   float[1] = posY      world-space Y (terrain-snapped)
//   float[2] = posZ      world-space Z of blade base
//   float[3] = seed      random [0,1] for visual variation
//   float[4] = rotation  Y-axis rotation in radians
//   float[5] = scale     blade height multiplier
//   float[6] = _pad0
//   float[7] = _pad1
// ---------------------------------------------------------------------------

struct GrassInstance {
  pos:      vec3<f32>,   // offset  0, size 12 — vec3 alignment=16 → next at 16
  seed:     f32,         // offset 16
  rotation: f32,         // offset 20
  scale:    f32,         // offset 24
  _pad:     vec2<f32>,   // offset 28 (8 bytes) — struct total = 36 → padded to 48 for array stride
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
// @group(1) declared in FS only (textures not needed in VS)
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

  // ── 1. Scale — stretch blade vertically by instance.scale ────────────────
  let scaledPos = vec3<f32>(position.x, position.y * inst.scale, position.z);

  // ── 2. Y-axis rotation ────────────────────────────────────────────────────
  let cosR = cos(inst.rotation);
  let sinR = sin(inst.rotation);
  let rotatedPos = vec3<f32>(
    scaledPos.x * cosR - scaledPos.z * sinR,
    scaledPos.y,
    scaledPos.x * sinR + scaledPos.z * cosR,
  );

  // ── 3. Wind animation ─────────────────────────────────────────────────────
  // Displacement grows from 0 at the root (position.y=0) to full at the tip (position.y=1).
  // Each blade gets an individual phase offset from its world position so the
  // whole field never sways in unison.
  let heightFactor = position.y; // local [0,1] before scale — zero at root
  let windPhase = (inst.pos.x * 0.08 + inst.pos.z * 0.05) + camera.time * 1.4;
  let windX = sin(windPhase)           * heightFactor * 0.28;
  let windZ = cos(windPhase * 0.73 + 1.3) * heightFactor * 0.14;

  // ── 4. World position ─────────────────────────────────────────────────────
  let worldPos = vec3<f32>(
    inst.pos.x + rotatedPos.x + windX,
    inst.pos.y + rotatedPos.y,
    inst.pos.z + rotatedPos.z + windZ,
  );

  // ── 5. Output ─────────────────────────────────────────────────────────────
  var output: VertexOutput;
  output.position  = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
  output.WorldPos  = worldPos;

  // Normal stays (0,1,0) for top-lit uniform shading across all blade faces.
  output.N = vec3<f32>(0.0, 1.0, 0.0);

  // Store the rotated tangent direction in T.xyz; use T.w to pass seed to FS
  // (seed drives a subtle colour tint, T.w replaces the unused handedness value).
  let rotatedTangentX = cosR;
  let rotatedTangentZ = sinR;
  output.T = vec4<f32>(rotatedTangentX, 0.0, rotatedTangentZ, inst.seed);

  output.Uv = uv;

  return output;
}
