#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "grass/grass_common"

// ---------------------------------------------------------------------------
// Grass billboard fragment shader — far LOD GBuffer output.
//
// Performs two Bayer-dithered LOD transitions:
//   • Fade-in : [lodFarFadeStart … lodNearFadeEnd]  — billboard appears as
//               the near LOD simultaneously fades out (crossfade zone).
//   • Fade-out: [lodFarFadeEnd - 8 … lodFarFadeEnd] — billboard disappears
//               at max draw distance.
//
// Colour computation mirrors grass.fs: UV-based bottom→top gradient with
// optional tall-zone tint (zone baked per instance at scatter time).
//
// T.y = camera distance from instance root (set by grass_billboard.vs).
// T.z = zone [0,1] for tall-zone colour tint.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform>  camera:       CameraUniforms;
@group(1) @binding(0) var           txAlbedo:     texture_2d<f32>;
@group(1) @binding(5) var           samplerState: sampler;
@group(1) @binding(6) var<uniform>  factors:      MaterialFactors;
@group(3) @binding(0) var<uniform>  grassUniforms: GrassUniforms;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
  let camDist = input.T.y;

  // ── Fade-in (crossfade with near LOD) ────────────────────────────────────
  // Fully invisible below lodFarFadeStart; blends in toward lodNearFadeEnd.
  if camDist < grassUniforms.lodFarFadeStart {
    discard;
  }
  if camDist < grassUniforms.lodNearFadeEnd {
    // Fade ratio: 1 at lodFarFadeStart (invisible) → 0 at lodNearFadeEnd (visible)
    let fadeIn = 1.0 - (camDist - grassUniforms.lodFarFadeStart)
                     / (grassUniforms.lodNearFadeEnd - grassUniforms.lodFarFadeStart);
    if fadeIn > bayer4x4(input.position.xy) {
      discard;
    }
  }

  // ── Fade-out (max draw distance) ─────────────────────────────────────────
  if camDist >= grassUniforms.lodFarFadeEnd {
    discard;
  }
  let fadeOutStart = grassUniforms.lodFarFadeEnd - 8.0;
  if camDist > fadeOutStart {
    let fadeOut = (camDist - fadeOutStart) / 8.0; // 0 → 1 as dist → lodFarFadeEnd
    if fadeOut > bayer4x4(input.position.xy) {
      discard;
    }
  }

  // ── Colour (same gradient logic as grass.fs) ──────────────────────────────
  let uv          = input.Uv;
  let colorBottom = factors.baseColorFactor.rgb;
  let colorTop    = vec3<f32>(factors.roughnessFactor, factors.metallicFactor, factors.emissiveFactor);
  let t           = smoothstep(factors.appearanceBlend, factors.surfaceBlend, uv.y);
  let gradientAlbedo = mix(colorBottom, colorTop, t);

  // Tall-zone tint (zone = 0 when no heightMap is used → no-op)
  let colorTall = vec3<f32>(factors.uvXScale, factors.uvYScale, factors.pomScale);
  let zone      = input.T.z;
  let albedo    = mix(gradientAlbedo, colorTall, smoothstep(0.4, 1.0, zone));

  // ── Normal — bent toward world-up (matching near LOD) ─────────────────────
  let N         = normalize(input.N);
  let bentN     = normalize(mix(N, vec3<f32>(0.0, 1.0, 0.0), 0.8));
  let encodedNorm = normalToOctahedral01(bentN);

  let roughness = 0.85;
  let metallic  = 0.0;
  let emissive  = 0.0;

  // ── Linear depth ──────────────────────────────────────────────────────────
  let camToWorld  = input.WorldPos - camera.cameraPosition.xyz;
  let linearDepth = dot(camToWorld, camera.cameraFront.xyz) / camera.cameraFar;

  var output: FragmentOutput;
  output.albedo = vec4<f32>(albedo, metallic);
  output.normal = vec4<f32>(encodedNorm.x, encodedNorm.y, roughness, emissive);
  output.depth  = linearDepth;
  return output;
}
