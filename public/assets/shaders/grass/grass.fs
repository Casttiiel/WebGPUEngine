#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// Grass blade fragment shader — UV-based two-colour gradient, GBuffer output.
//
// MaterialFactors fields are repurposed for the gradient:
//   baseColorFactor.rgb  = colorBottom  colour at UV.y = 0
//   roughnessFactor      = colorTop.r   }
//   metallicFactor       = colorTop.g   }  colour at UV.y = 1
//   emissiveFactor       = colorTop.b   }
//   appearanceBlend      = blendStart   UV.y <= this  → 100 % colorBottom
//   surfaceBlend         = blendEnd     UV.y >= this  → 100 % colorTop
//
// All colour values are in linear space.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform>  camera:       CameraUniforms;
@group(1) @binding(0) var           txAlbedo:     texture_2d<f32>;
@group(1) @binding(5) var           samplerState: sampler;
@group(1) @binding(6) var<uniform>  factors:      MaterialFactors;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
  let uv = input.Uv;

  // ── UV gradient ──────────────────────────────────────────────────────────
  let colorBottom = factors.baseColorFactor.rgb;
  let colorTop    = vec3<f32>(factors.roughnessFactor, factors.metallicFactor, factors.emissiveFactor);
  // smoothstep: 0.0 below blendStart, 1.0 above blendEnd, smooth S-curve between.
  let t           = smoothstep(factors.appearanceBlend, factors.surfaceBlend, uv.y);
  let albedo      = mix(colorBottom, colorTop, t);

  // ── Normal ────────────────────────────────────────────────────────────────
  let N           = normalize(input.N);
  let encodedNorm = normalToOctahedral01(N);

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
