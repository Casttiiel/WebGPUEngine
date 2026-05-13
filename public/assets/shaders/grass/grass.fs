#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// Grass fragment shader — alpha-cutout GBuffer output
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = custom material slots (txAlbedo + samplerState)
// @group(2) = InstanceStorage (declared in VS only, not needed here)
//
// Uses alpha-cutout (discard) so the transparent parts of a grass blade sprite
// don't write to the GBuffer.  A plain 'white.png' albedo (alpha = 1) can be
// used for initial testing without any discards.
//
// Seed is passed through VertexOutput.T.w and drives a subtle colour tint so
// adjacent blades don't look identical.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:     texture_2d<f32>;
@group(1) @binding(1) var samplerState: sampler;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
  // ── Sample albedo + alpha ──────────────────────────────────────────────────
  let raw = textureSample(txAlbedo, samplerState, input.Uv);

  // Alpha cutout — discard fully transparent fragments so grass silhouettes
  // work correctly against opaque geometry in the GBuffer.
  if (raw.a < 0.5) {
    discard;
  }

  // ── sRGB → linear albedo ───────────────────────────────────────────────────
  var albedo_linear = pow(abs(raw.rgb), vec3<f32>(2.2));

  // ── Per-blade colour tint via seed (packed in T.w by VS) ──────────────────
  // A subtle [0.9,1.0] range so blades aren't too uniform without looking unnatural.
  let seed      = input.T.w;
  let tintScale = 0.9 + seed * 0.1;
  albedo_linear *= tintScale;

  // ── Normal encoding ────────────────────────────────────────────────────────
  // The blade normal is always (0,1,0) in VS; SAA variance is zero since
  // there is no normal-map lookup here.  Roughness is hardcoded for foliage.
  let N            = normalize(input.N);
  let encodedNorm  = normalToOctahedral01(N);

  let roughness = 0.85;   // typical matte foliage
  let metallic  = 0.0;
  let emissive  = 0.0;

  // ── GBuffer output ─────────────────────────────────────────────────────────
  var output: FragmentOutput;

  // albedo.rgb = linear colour, albedo.a = metallic
  output.albedo = vec4<f32>(albedo_linear, metallic);

  // normal.rg = octahedral-encoded normal, normal.b = roughness, normal.a = emissive
  output.normal = vec4<f32>(encodedNorm.x, encodedNorm.y, roughness, emissive);

  // Linear depth (same formula as gbuffer.fs)
  let camToWorld = input.WorldPos - camera.cameraPosition.xyz;
  output.depth   = dot(camToWorld, camera.cameraFront.xyz) / camera.cameraFar;

  return output;
}
