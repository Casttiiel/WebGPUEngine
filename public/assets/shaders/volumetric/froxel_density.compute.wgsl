#include "common/uniforms"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Bind groups
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

@group(3) @binding(0) var noiseTex: texture_2d<f32>;
@group(3) @binding(1) var noiseSampler: sampler;
@group(3) @binding(2) var linearDepth: texture_2d<f32>;
@group(3) @binding(3) var<uniform> fogVolumeData: FogVolumeData;

// Triplanar sample of the RGB tileable noise texture at a given world position and scale.
// Uses the 3 channels for independent variation across projections.
fn triplanarNoise(worldPos: vec3<f32>, scale: f32, windOffset: vec3<f32>) -> f32 {
    let p    = (worldPos + windOffset) * scale;
    let dims = vec2<f32>(textureDimensions(noiseTex));

    let uv1 = fract(p.xy); let uv2 = fract(p.yz); let uv3 = fract(p.zx);

    // Each projection uses a different channel so they blend independently
    let c1 = textureLoad(noiseTex, vec2<i32>(uv1 * dims), 0).r;  // XY → R
    let c2 = textureLoad(noiseTex, vec2<i32>(uv2 * dims), 0).g;  // YZ → G
    let c3 = textureLoad(noiseTex, vec2<i32>(uv3 * dims), 0).b;  // ZX → B
    return (c1 + c2 + c3) * 0.3333;
}

// FBM: 3 octaves of triplanar noise with wind advection per octave.
// Slower-moving large scales + faster-moving small details = turbulent wisps.
// windDir.xz = Wind singleton direction×speed (world units/s, XZ plane only).
// windDir.y is repurposed for cameraFar — never use it as wind.
fn sampleNoise3D(worldPos: vec3<f32>) -> f32 {
    // Horizontal wind only (Y=0 keeps fog layer from drifting vertically)
    let wind = vec3<f32>(volumetricParams.windDir.x, 0.0, volumetricParams.windDir.z) * camera.time;

    // Octave 1 – large base shape (slow)
    let n1 = triplanarNoise(worldPos, 0.012, wind * 1.0);
    // Octave 2 – medium detail (medium speed)
    let n2 = triplanarNoise(worldPos, 0.030, wind * 1.7);
    // Octave 3 – fine wisps (fast)
    let n3 = triplanarNoise(worldPos, 0.075, wind * 2.8);

    // FBM weights: 1 + 0.5 + 0.25 = 1.75
    return (n1 + n2 * 0.5 + n3 * 0.25) / 1.75;
}

// -----------------------------------------------------------------------
// Fog Volume SDF helpers
// -----------------------------------------------------------------------

/// Signed distance to an axis-aligned box centered at the origin.
fn sdfBox(p: vec3<f32>, halfExtents: vec3<f32>) -> f32 {
    let d = abs(p) - halfExtents;
    return length(max(d, vec3<f32>(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
}

/// Signed distance to a sphere centered at the origin.
fn sdfSphere(p: vec3<f32>, radius: f32) -> f32 {
    return length(p) - radius;
}

/// Applies all active fog volumes on top of the base sigmaS / sigmaT values.
/// Returns vec2(finalSigmaS, finalSigmaT).
fn applyFogVolumes(worldPos: vec3<f32>, baseSigmaS: f32, baseSigmaT: f32) -> vec2<f32> {
    var outS = baseSigmaS;
    var outT = baseSigmaT;

    for (var i = 0u; i < fogVolumeData.count; i++) {
        let vol = fogVolumeData.volumes[i];

        // Signed distance from froxel world position to volume surface
        let localPos = worldPos - vol.center;
        var sdf: f32;
        if (vol.shape < 0.5) {
            // Sphere — halfExtents.x stores the radius
            sdf = sdfSphere(localPos, vol.halfExtents.x);
        } else {
            // Box
            sdf = sdfBox(localPos, vol.halfExtents);
        }

        // blend = 1 inside, smoothly falls to 0 over [0, falloff] outside the surface
        let blend = saturate(smoothstep(0.0, vol.falloff, -sdf));

        if (blend > 0.0) {
            if (vol.blendMode < 0.5) {
                // "add" — accumulate density on top of the global fog
                outS += vol.sigmaS * blend;
                outT += vol.sigmaT * blend;
            } else {
                // "override" — lerp toward the volume's density (clears fog in interiors)
                outS = mix(outS, vol.sigmaS, blend);
                outT = mix(outT, vol.sigmaT, blend);
            }
        }
    }

    return vec2<f32>(outS, outT);
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let froxelCoord = globalId.xyz;
  
  // Bounds check
  if (froxelCoord.x >= u32(froxelParams.dimensions.x) ||
    froxelCoord.y >= u32(froxelParams.dimensions.y) ||
    froxelCoord.z >= u32(froxelParams.dimensions.z)) {
    return;
  }

  let froxelVS = froxelToViewSpace(
    globalId, 
    froxelParams.dimensions.xyz,
    froxelParams.nearPlane,
    froxelParams.farPlane,
    camera.invProjection
  );
  let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
  let froxelWS = tempFroxelWS.xyz / tempFroxelWS.w;


  // 2) Height fog (parameters from uniform)
  let fogBaseHeight = volumetricParams.fogBaseHeight;
  let fogLayerHeight = volumetricParams.fogLayerHeight;
  let fogFalloff = volumetricParams.fogFalloff;

  let h = froxelWS.y - fogBaseHeight;

  // Altura normalizada dentro de la capa
  let layerT = saturate(h / fogLayerHeight);

  // Capa más densa abajo
  let layerShape = smoothstep(0.0, 1.0, 1.0 - layerT);

  // Decay arriba
  let above = max(h - fogLayerHeight, 0.0);
  let expFalloff = exp(-above * fogFalloff);

  let heightFog = layerShape * expFalloff;

  // Base density
  var densityFinal = volumetricParams.fogDensity * heightFog;

  // 3D Noise
  let noise = sampleNoise3D(froxelWS);

  // Más noise abajo
  let heightMask = saturate(1.0 - layerT);
  let layeredNoise = mix(1.0, noise, heightMask);

  // Mucho más contraste para shafts
  let shapedNoise = smoothstep(0.2, 0.8, layeredNoise);
  let noiseFactor = mix(0.5, 1.8, shapedNoise);

  densityFinal *= noiseFactor;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;

  // Apply world-space density volumes (SDF blend)
  let finalParams = applyFogVolumes(froxelWS, sigmaS, sigmaT);

  // Store density in 3D texture (rg32float: R=sigmaS, G=sigmaT)
  // Depth-awareness is handled in the integration pass, which stops accumulation
  // per-column when the froxel depth exceeds the scene geometry depth.
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(finalParams.x, finalParams.y, 0.0, 0.0));
}
