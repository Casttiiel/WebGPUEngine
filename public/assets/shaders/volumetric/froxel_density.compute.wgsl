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

// Función para samplear noise 3D desde textura 2D RGB tileable
fn sampleNoise3D(worldPos: vec3<f32>) -> f32 {
    let scale = 0.02;
    let wind = vec3<f32>(1.0, 0.0, 0.7);

    // Separar el scale del noise del movimiento temporal para control independiente
    let p = (worldPos + wind * camera.time) * scale;

    let dims = vec2<f32>(textureDimensions(noiseTex));

    // Proyecciones 2D para simular 3D
    let uv1 = fract(p.xy);
    let uv2 = fract(p.yz);
    let uv3 = fract(p.zx);

    let c1 = textureLoad(
        noiseTex,
        vec2<i32>(uv1 * dims),
        0
    ).r;

    let c2 = textureLoad(
        noiseTex,
        vec2<i32>(uv2 * dims),
        0
    ).r;

    let c3 = textureLoad(
        noiseTex,
        vec2<i32>(uv3 * dims),
        0
    ).r;

    // Promedio para volumen suave
    return (c1 + c2 + c3) * (1.0 / 3.0);
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
  let shapedNoise = smoothstep(0.3, 0.6, layeredNoise);
  let noiseFactor = mix(0.2, 2.5, shapedNoise);

  densityFinal *= noiseFactor;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;
  
  // Store density in 3D texture (R32F format)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(sigmaS, sigmaT, 0.0, 0.0));
}
