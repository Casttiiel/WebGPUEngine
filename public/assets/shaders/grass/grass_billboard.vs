#include "common/uniforms"
#include "common/structs"
#include "grass/grass_common"

// ---------------------------------------------------------------------------
// Grass billboard vertex shader — far LOD (cross-billboard, two quads in X).
//
// Uses the same GrassInstance storage buffer as grass_instanced.vs (@group 2)
// and the same GrassUniforms wind/LOD buffer (@group 3).
//
// Wind: only Phase 2 (slow directional sway) is applied — at 20–55 m individual
// blade wiggle is imperceptible, so the cheaper animation is sufficient.
//
// The cross-billboard mesh (grass_blade.gltf) has a fixed rotation baked at
// scatter time; no camera-facing needed because the X shape looks acceptable
// from all horizontal viewing angles.
//
// Camera distance from the instance root is packed into output.T.y so the
// fragment shader can perform Bayer-dithered fade-in and fade-out.
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = MaterialTextures  (FS only — not declared here)
// @group(2) = InstanceStorage   (array<GrassInstance>)
// @group(3) = GrassUniforms     (wind + LOD params, updated each frame)
// ---------------------------------------------------------------------------

struct GrassInstance {
  pos:      vec3<f32>,   // offset  0, size 12
  seed:     f32,         // offset 12
  rotation: f32,         // offset 16
  scale:    f32,         // offset 20
  zone:     f32,         // offset 24 — height-map zone [0,1]
  _pad:     f32,         // offset 28
}

@group(0) @binding(0) var<uniform>           camera:       CameraUniforms;
@group(2) @binding(0) var<storage, read>     instances:    array<GrassInstance>;
@group(3) @binding(0) var<uniform>           grassUniforms: GrassUniforms;

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,
  @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
  let inst = instances[instanceIdx];
  let t    = camera.time;
  let ws   = grassUniforms.windSpeed;

  // 1. Uniform scale
  let scaledPos = position * inst.scale;

  // 2. Y-axis rotation (baked at scatter time — orients the cross billboard)
  let cosR = cos(inst.rotation);
  let sinR = sin(inst.rotation);
  let rotatedPos = vec3<f32>(
    scaledPos.x * cosR - scaledPos.z * sinR,
    scaledPos.y,
    scaledPos.x * sinR + scaledPos.z * cosR,
  );

  // 3. Base world position
  let worldPos = inst.pos + rotatedPos;

  // Height factor (0 = root, 1 = tip).
  let h = 1.0 - uv.y;

  // ── Phase 2: Sway only ───────────────────────────────────────────────────
  // Slow directional bend along windDir.  Cheap enough for thousands of
  // billboard instances; the other phases are imperceptible at this distance.
  let spatialPhase = (worldPos.x + worldPos.z) * 0.04;
  let swayPhase    = t * grassUniforms.swayFrequency * ws + spatialPhase;
  let swayAmt      = sin(swayPhase) * grassUniforms.swayIntensity * h;
  let swayX        = grassUniforms.windDir.x * swayAmt;
  let swayZ        = grassUniforms.windDir.y * swayAmt;

  let animatedPos = vec3<f32>(
    worldPos.x + swayX,
    worldPos.y,
    worldPos.z + swayZ,
  );

  // Camera distance from instance root (passed to FS for LOD dithering).
  let camDist = length(inst.pos - camera.cameraPosition.xyz);

  var output: VertexOutput;
  output.WorldPos = animatedPos;
  output.position = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(animatedPos, 1.0);
  output.N  = normal;
  output.T  = vec4<f32>(1.0, camDist, inst.zone, inst.seed); // T.y=camDist, T.z=zone, T.w=seed
  output.Uv = uv;
  return output;
}
