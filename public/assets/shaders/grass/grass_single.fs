#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// Grass single-blade fragment shader — alpha cutout, GBuffer output.
// Uses the standard MaterialTextures layout (txAlbedo at binding 0).
// Procedural taper discards fragments outside the blade silhouette.
// UV layout (grass_blade.obj): U=0..1 across width, V=1 at base, V=0 at tip.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform>  camera:       CameraUniforms;
@group(1) @binding(0) var           txAlbedo:     texture_2d<f32>;
@group(1) @binding(5) var           samplerState: sampler;
@group(1) @binding(6) var<uniform>  factors:      MaterialFactors;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
  let uv = input.Uv;

  // ── Texture alpha discard ────────────────────────────────────────────────
  let raw = textureSample(txAlbedo, samplerState, uv);
  if (raw.a < 0.5) {
    discard;
  }

  // ── Albedo (sRGB → linear) ────────────────────────────────────────────────
  let albedo_linear = pow(abs(raw.rgb), vec3<f32>(2.2));

  // ── Normal (flat up for grass blades) ────────────────────────────────────
  let N = normalize(input.N);
  let encodedNorm = normalToOctahedral01(N);

  let roughness = 0.85;
  let metallic  = 0.0;
  let emissive  = 0.0;

  // ── Linear depth ────────────────────────────────────────────────────────
  let camToWorld = input.WorldPos - camera.cameraPosition.xyz;
  let linearDepth = dot(camToWorld, camera.cameraFront.xyz) / camera.cameraFar;

  var output: FragmentOutput;
  output.albedo = vec4<f32>(albedo_linear, metallic);
  output.normal = vec4<f32>(encodedNorm.x, encodedNorm.y, roughness, emissive);
  output.depth  = linearDepth;
  return output;
}
