#include "common/uniforms"
#include "common/structs"
#include "common/math/coordinates"
#include "common/octahedral"
#include "common/gbuffer"

struct FogUniforms {
  color: vec4<f32>,          // rgb = color del fog
  density: f32,              // densidad base para Beer-Lambert
  extinction: f32,           // NOT USED
  height: f32,               // altura base del fog (world space)
  heightFalloff: f32,        // >0 hace más denso cerca del suelo
  start: f32,                // depth fog start (en metros/unidades)
  end: f32,                  // depth fog end
  inscatter: f32,            // intensidad de inscattering (0..1 típicamente)
  noiseAmount: f32,          // cuánto afecta el ruido (0..1)
  noiseScale: f32,           // escala del ruido en mundo
  noiseSpeed: f32           // animación del ruido
};


fn saturate3(v: vec3<f32>) -> vec3<f32> {
  return clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Hash noise barato (0..1). No es Perlin, pero para fog vale.
fn hash12(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}


@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;
@group(2) @binding(0) var<uniform> fog : FogUniforms;
@group(2) @binding(1) var sceneColor : texture_2d<f32>;
@group(2) @binding(2) var texSampler : sampler;

@fragment
fn fs(@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let base  = textureSample(sceneColor, texSampler, uv);
  let g = decodeGBuffer(uv);

  let skyDistance = 100.0;
  let skyFogMultiplier = 1.0;

  // Cielo cuando depth ~ 1
  let skyMask = smoothstep(0.995, 1.0, g.zlinear);

  let worldPos = g.worldPos;

  // Distancia (viewZ lineal)
  let distGeom = g.zlinear * camera.cameraFar;

  let skyDist = select(fog.end * 2.0, skyDistance, skyDistance > 0.0);
  let dist = mix(distGeom, skyDist, skyMask);

  // -----------------------------
  // Height factor (con sky fix)
  // -----------------------------
  let heightFactorGeom = exp(-fog.heightFalloff * (worldPos.y - fog.height));
  let heightFactor = mix(heightFactorGeom, 1.0, skyMask);

  // -----------------------------
  // Noise (estable en sky)
  // -----------------------------
  let noisePosXZ = mix(worldPos.xz, uv * 100.0, skyMask);
  let noiseUV = (noisePosXZ * fog.noiseScale);
  let n = hash12(noiseUV);

  let noiseFactor = mix(1.0, (n * 2.0), fog.noiseAmount);

  // ✅ Esta densidad modulada afecta a TODO el fog
  let densityMod = clamp(heightFactor * noiseFactor, 0.0, 10.0);

  // ✅ Base sigma (si no quieres extinction, ponlo a 1.0)
  let sigmaBase = fog.density; // o fog.density * fog.extinction

  // -----------------------------
  // Depth fog exponencial
  // -----------------------------
  let d = max(dist - fog.start, 0.0);
  let sigmaDepth = sigmaBase * densityMod;
  let depthFog = 1.0 - exp(-sigmaDepth * d);

  // -----------------------------
  // Fog “total” tipo Beer-Lambert
  // -----------------------------
  let sigmaT = sigmaBase * densityMod;
  let T = exp(-sigmaT * dist);
  let fogAmountExp = 1.0 - T;

  // ✅ Combina los dos correctamente
  var fogAmount = 1.0 - (1.0 - fogAmountExp) * (1.0 - depthFog);

  // ✅ Ajuste extra para el cielo
  fogAmount = saturate(mix(fogAmount, fogAmount * skyFogMultiplier, skyMask));

  // -----------------------------
  // Composición final
  // -----------------------------
  let extinctionColor = base.rgb * T;
  let inscatterColor = fog.color.rgb * fogAmount * fog.inscatter;

  let finalRGB = extinctionColor + inscatterColor;

  return vec4<f32>(finalRGB, 1.0);
}
