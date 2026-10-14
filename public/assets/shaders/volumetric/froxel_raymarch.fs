#include "common/core/constants"
#include "common/uniforms"
#include "common/structs"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#include "common/lighting/csm"

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;
@group(0) @binding(2) var froxelIntegratedTexture: texture_3d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var blueNoiseTex: texture_2d<f32>;
@group(0) @binding(5) var nearestSampler: sampler;

// G-Buffer depth for proper ray termination
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// Sun cascaded shadow maps (same layout as the god rays pass)
@group(2) @binding(0) var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(2) @binding(1) var shadowMap0: texture_depth_2d;
@group(2) @binding(2) var shadowMap1: texture_depth_2d;
@group(2) @binding(3) var shadowMap2: texture_depth_2d;
@group(2) @binding(4) var shadowSampler: sampler_comparison;

// Per-slice froxel data used to rebuild the partially covered slice
@group(3) @binding(0) var<uniform> camera: CameraUniforms;
@group(3) @binding(1) var froxelDensityTexture: texture_3d<f32>;       // sigmaS, sigmaT
@group(3) @binding(2) var froxelLightTexture: texture_3d<f32>;         // temporally filtered light, .a = sun factor
@group(3) @binding(3) var froxelSelfOcclusionTexture: texture_3d<f32>; // sun transmittance through the medium

fn sunShadow(worldPos: vec3<f32>, viewDepth: f32) -> f32 {
  let cascadeIndex = selectCascadeCSM(viewDepth, directionalLight.cascadeSplits);
  if (cascadeIndex == 0) {
    return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
      directionalLight.shadowParams.x, shadowMap0, shadowSampler);
  } else if (cascadeIndex == 1) {
    return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
      directionalLight.shadowParams.y, shadowMap1, shadowSampler);
  }
  return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
    directionalLight.shadowParams.z, shadowMap2, shadowSampler);
}

fn sampleIntegrated(xy: vec2<f32>, texelZ: f32, dimsF: vec3<f32>) -> vec4<f32> {
  let uvw = vec3<f32>(xy / dimsF.xy, (texelZ + 0.5) / dimsF.z);
  return textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dimsF = froxelParams.dimensions.xyz;
  let dimsI = vec3<i32>(dimsF);

  // Per-pixel view depth (linear depth is viewZ / cameraFar; sky is cleared to 1).
  // cameraFar is packed into volumetricSettings.windDir.y by FroxelVolumetricScattering.ts
  let depthDims = vec2<i32>(textureDimensions(gLinearDepth));
  let pixel = min(vec2<i32>(uv * vec2<f32>(depthDims)), depthDims - vec2<i32>(1));
  let depth01 = textureLoad(gLinearDepth, pixel, 0).x;
  let viewZ = depth01 * volumetricSettings.windDir.y;

  // Continuous slice coordinate of the surface.
  let s = froxelDepthToSlice(viewZ, froxelParams.depthDistScale, froxelParams.depthDistB);

  // Animated blue noise: x/y → ±0.25 froxel XY dither (breaks up the 8 px
  // bilinear footprint), z → position of the sun shadow tap in the partial slice.
  let frameOffset = fract(volumetricSettings.windDir.w * 0.61803398874);
  let noiseUV = fract(uv * vec2<f32>(volumetricSettings.renderWidth, volumetricSettings.renderHeight) / 64.0 + frameOffset);
  let noise = vec3<f32>(
    textureSampleLevel(blueNoiseTex, nearestSampler, noiseUV, 0.0).r,
    textureSampleLevel(blueNoiseTex, nearestSampler, fract(noiseUV + vec2<f32>(0.5, 0.25)), 0.0).r,
    textureSampleLevel(blueNoiseTex, nearestSampler, fract(noiseUV + vec2<f32>(0.25, 0.75)), 0.0).r
  );
  let xy = uv * dimsF.xy + (noise.xy - vec2<f32>(0.5)) * 0.5;

  var result: vec4<f32>;
  if (froxelParams.dimensions.w > 7.5 && froxelParams.dimensions.w < 8.5) { // DEBUG replicate injection
    let sh = froxelDepthToSlice(viewZ * 0.5, froxelParams.depthDistScale, froxelParams.depthDistB);
    let base3 = floor(vec3<f32>(uv * dimsF.xy, sh));
    var vis = 0.0;
    for (var i = 0u; i < 4u; i++) {
      let fi = f32(i);
      let jxy = fract(froxelParams.jitter.xy + vec2<f32>(0.7548776662, 0.5698402910) * fi);
      let jz = (fi + froxelParams.jitter.z) / 4.0;
      let pVS = froxelCoordToViewSpace(base3 + vec3<f32>(jxy, jz), dimsF, froxelParams.depthDistScale, froxelParams.depthDistB, camera.invProjection);
      let pWS = (camera.invView * vec4<f32>(pVS, 1.0)).xyz;
      vis += sunShadow(pWS, -pVS.z);
    }
    let stored = textureLoad(froxelLightTexture, vec3<i32>(base3), 0);
    let selfS = textureLoad(froxelSelfOcclusionTexture, vec3<i32>(base3), 0).r;
    let sampled = textureSampleLevel(froxelLightTexture, linearSampler, (base3 + vec3<f32>(0.5)) / dimsF, 0.0);
    return vec4<f32>(vis * 0.25 * 100.0, stored.a * 20.0, 0.0, 0.0);
  }
  if (froxelParams.dimensions.w > 5.5 && froxelParams.dimensions.w < 6.5) { // DEBUG froxel light at 50% depth
    let sh = froxelDepthToSlice(viewZ * 0.5, froxelParams.depthDistScale, froxelParams.depthDistB);
    let Lh = textureSampleLevel(froxelLightTexture, linearSampler, vec3<f32>(uv, sh / dimsF.z), 0.0);
    return vec4<f32>(vec3<f32>(Lh.a), 0.0);
  }

  if (froxelParams.dimensions.w > 6.5) { // DEBUG: sun visibility just in front of the surface
    let r = computeViewRayFromUV(vec2<f32>(uv.x, 1.0 - uv.y), camera.invProjection);
    let d = viewZ * fract(froxelParams.dimensions.w * 0.01) * 1.0 + select(0.0, 0.0, false);
    let p = (camera.invView * vec4<f32>(r * d, 1.0)).xyz;
    if (froxelParams.dimensions.w > 99.5) {
      let c1 = getShadowFactorForCascade(p, directionalLight.viewProjOffset1, 0.0, shadowMap1, shadowSampler);
      let c0 = getShadowFactorForCascade(p, directionalLight.viewProjOffset0, 0.0, shadowMap0, shadowSampler);
      return vec4<f32>(c0, c1, f32(selectCascadeCSM(d, directionalLight.cascadeSplits)) * 0.5, 0.0);
    }
    return vec4<f32>(sunShadow(p, d) * 100.0, sunShadow(p, d), 0.0, 0.0);
  }

  if (froxelParams.sunPartial < 0.5 || s >= dimsF.z) {
    // Plain lookup. Texel k holds the integral up to the far boundary of slice k,
    // so texel coordinate s-1 interpolates inside the surface's own slice.
    result = sampleIntegrated(xy, clamp(s - 1.0, 0.0, dimsF.z - 1.0), dimsF);
    if (s < 1.0) {
      result = mix(vec4<f32>(0.0, 0.0, 0.0, 1.0), result, max(s, 0.0));
    }
  } else {
    // ── Exact last slice ──────────────────────────────────────────────────────
    // Everything up to the near boundary of the surface's slice comes from the
    // integrated volume (that region is entirely in front of the surface).
    // The partial segment [sliceStart, surface] is rebuilt per pixel: the
    // froxel's averaged sun term — which also covers space BEHIND the surface
    // and would leak light onto it — is replaced by an exact shadow-map tap
    // at a jittered point of the visible segment.
    let k = i32(floor(s));
    var base = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    if (k > 0) {
      base = sampleIntegrated(xy, f32(k - 1), dimsF);
    }

    let sliceStart = froxelSliceToDepth(f32(k), froxelParams.depthDistScale, froxelParams.depthDistB);
    let ray = computeViewRayFromUV(vec2<f32>(uv.x, 1.0 - uv.y), camera.invProjection); // z = -1
    let ds = max(viewZ - sliceStart, 0.0) * length(ray);

    let froxel = vec3<i32>(clamp(vec2<i32>(xy), vec2<i32>(0), dimsI.xy - vec2<i32>(1)), k);
    let sigma = textureLoad(froxelDensityTexture, froxel, 0);
    let sigmaS = max(sigma.r, 0.0);
    let sigmaT = max(sigma.g, 0.0);
    let selfShadow = textureLoad(froxelSelfOcclusionTexture, froxel, 0).r;
    let L = textureSampleLevel(froxelLightTexture, linearSampler,
      vec3<f32>(xy / dimsF.xy, (f32(k) + 0.5) / dimsF.z), 0.0);

    let sunRadiance = directionalLight.color * directionalLight.intensity;
    let otherLight = max(L.rgb - sunRadiance * L.a, vec3<f32>(0.0));

    let tapDepth = mix(sliceStart, viewZ, noise.z);
    let tapVS = ray * tapDepth;
    let tapWS = (camera.invView * vec4<f32>(tapVS, 1.0)).xyz;
    let visibility = sunShadow(tapWS, tapDepth);

    let V = normalize(camera.cameraPosition.xyz - tapWS);
    let cosTheta = clamp(dot(V, normalize(-directionalLight.position)), -1.0, 1.0);
    let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95);
    let phase = mix(1.0 / (4.0 * PI), phaseHG(cosTheta, g), 0.9);

    let Lpx = otherLight + sunRadiance * phase * selfShadow * visibility;

    let msBoost = mix(volumetricSettings.multipleScatteringBoost, 1.0, 1.0 - base.a);
    let scatter = Lpx * sigmaS * msBoost;
    let segT = exp(-sigmaT * ds);
    let integ = select(scatter * ds, scatter * (1.0 - segT) / max(sigmaT, 1e-7), sigmaT > 1e-5);
    result = vec4<f32>(base.rgb + base.a * integ, base.a * segT);
    if (froxelParams.dimensions.w > 2.5 && froxelParams.dimensions.w < 3.5) { return vec4<f32>(base.rgb, 0.0); } // DEBUG
    if (froxelParams.dimensions.w > 3.5 && froxelParams.dimensions.w < 4.5) { return vec4<f32>(base.a * integ, 0.0); } // DEBUG
    if (froxelParams.dimensions.w > 4.5 && froxelParams.dimensions.w < 5.5) { return vec4<f32>(f32(k) / dimsF.z, s / dimsF.z, viewZ / 50.0, 0.0); } // DEBUG
  }

  if (froxelParams.dimensions.w > 0.5) { return vec4<f32>(result.rgb, 0.0); }
  return result;
}
