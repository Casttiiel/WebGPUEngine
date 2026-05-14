#include "common/uniforms"
#include "common/structs"

// ---------------------------------------------------------------------------
// Grass instanced vertex shader — GPU storage buffer path.
// Per-instance data: @group(2) = GrassInstance storage buffer.
// Wind uniforms:     @group(3) = GrassUniforms (updated every frame from Wind.ts).
//
// Three-phase wind animation:
//   Phase 1 — Wiggle : fast, chaotic XZ movement (multiple overlapping sines)
//   Phase 2 — Sway   : slow directional bend oscillating along windDir
//   Phase 3 — Gusts  : moving stripe pattern that boosts wiggle + sway amplitude
//
// All amplitudes are gated by uv.y (0 = root, 1 = tip).
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = MaterialTextures  (FS only — not declared here)
// @group(2) = InstanceStorage   (array<GrassInstance>)
// @group(3) = GrassUniforms     (wind params, CPU → GPU each frame)
// ---------------------------------------------------------------------------

struct GrassInstance {
  pos:      vec3<f32>,   // offset  0, size 12
  seed:     f32,         // offset 12 — immediately after vec3 (AlignOf(f32)=4, no gap)
  rotation: f32,         // offset 16
  scale:    f32,         // offset 20
  _pad:     vec2<f32>,   // offset 24 (8 bytes) — struct stride = 32 bytes = 8 floats
}

// Wind parameters uploaded every frame from Wind.ts via GrassVolumeComponent.update().
struct GrassUniforms {
  windDir:         vec2<f32>,  // offset  0 — normalised XZ wind direction
  windSpeed:       f32,        // offset  8 — overall speed / amplitude scale
  wiggleIntensity: f32,        // offset 12 — Phase 1: max chaotic XZ wiggle (m)
  wiggleFrequency: f32,        // offset 16 — Phase 1: spatial frequency
  swayIntensity:   f32,        // offset 20 — Phase 2: max directional sway (m)
  swayFrequency:   f32,        // offset 24 — Phase 2: oscillation rate
  gustFrequency:   f32,        // offset 28 — Phase 3: spatial stripe frequency
  gustSpeed:       f32,        // offset 32 — Phase 3: stripe travel speed
  gustIntensity:   f32,        // offset 36 — Phase 3: amplitude multiplier at gust peak
  // struct size 40 bytes, AlignOf 8 → buffer allocated as 48 bytes
}

@group(0) @binding(0) var<uniform> camera:       CameraUniforms;
@group(2) @binding(0) var<storage, read> instances: array<GrassInstance>;
@group(3) @binding(0) var<uniform> grassUniforms: GrassUniforms;

// Cheap position-based hash for breaking gust stripe uniformity.
fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

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

  // 2. Y-axis rotation
  let cosR = cos(inst.rotation);
  let sinR = sin(inst.rotation);
  let rotatedPos = vec3<f32>(
    scaledPos.x * cosR - scaledPos.z * sinR,
    scaledPos.y,
    scaledPos.x * sinR + scaledPos.z * cosR,
  );

  // 3. Base world position (pre-wind)
  let worldPos = inst.pos + rotatedPos;

  // Height factor: 0 = root (no movement), 1 = tip (full amplitude).
  // uv.y is 1 at root and 0 at tip in the exported mesh, so invert.
  let h = 1.0 - uv.y;

  // ── Phase 1: Wiggle ──────────────────────────────────────────────────────
  // Three overlapping sine waves with distinct frequencies/phases per axis.
  let wf = grassUniforms.wiggleFrequency;
  let wA = worldPos.x * wf              + t * ws * 3.7;
  let wB = worldPos.z * wf * 1.3        - t * ws * 2.9;
  let wC = (worldPos.x + worldPos.z) * wf * 0.8 + t * ws * 4.1;
  let wiggleX = (sin(wA)            * 0.5
               + sin(wB * 1.7 + 0.5) * 0.3
               + sin(wC * 0.9 - 0.8) * 0.2) * grassUniforms.wiggleIntensity * h;
  let wiggleZ = (cos(wB)            * 0.5
               + cos(wA * 1.4 - 1.2) * 0.3
               + cos(wC * 1.1 + 0.3) * 0.2) * grassUniforms.wiggleIntensity * h;

  // ── Phase 2: Sway ────────────────────────────────────────────────────────
  // Slow bend along windDir; spatial offset phases adjacent blades slightly.
  let spatialPhase = (worldPos.x + worldPos.z) * 0.04;
  let swayPhase    = t * grassUniforms.swayFrequency * ws + spatialPhase;
  let swayAmt      = sin(swayPhase) * grassUniforms.swayIntensity * h;
  let swayX        = grassUniforms.windDir.x * swayAmt;
  let swayZ        = grassUniforms.windDir.y * swayAmt;

  // ── Phase 3: Gusts ───────────────────────────────────────────────────────
  // Moving stripe pattern projected along windDir creates waves of intensity.
  // Position-dependent hash noise breaks the visual regularity.
  let gustProj = dot(worldPos.xz, grassUniforms.windDir);
  let gustRaw  = sin(gustProj * grassUniforms.gustFrequency - t * grassUniforms.gustSpeed * ws);
  let gustT    = gustRaw * 0.5 + 0.5;                      // remap [-1,1] → [0,1]
  let noise    = hash2(floor(worldPos.xz * 0.3) + vec2<f32>(inst.seed));
  let gustMask = clamp(gustT + noise * 0.4 - 0.2, 0.0, 1.0);

  // Gusts boost the amplitude of both wiggle and sway.
  let gustBoost = 1.0 + gustMask * grassUniforms.gustIntensity;

  // ── Combined displacement ─────────────────────────────────────────────────
  let animatedPos = vec3<f32>(
    worldPos.x + (wiggleX + swayX) * gustBoost,
    worldPos.y,
    worldPos.z + (wiggleZ + swayZ) * gustBoost,
  );

  var output: VertexOutput;
  output.WorldPos = animatedPos;
  output.position = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(animatedPos, 1.0);
  output.N  = normal;
  output.T  = vec4<f32>(1.0, 0.0, 0.0, inst.seed); // seed packed in T.w for FS tint
  output.Uv = uv;
  return output;
}
