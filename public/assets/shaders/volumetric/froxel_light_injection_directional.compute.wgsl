#include "common/core/constants"
#include "common/uniforms"
#include "common/structs"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#include "common/lighting/csm"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelLightTexture: texture_storage_3d<rgba16float, write>;
@group(2) @binding(1) var<uniform> ambientLight: AmbientLightUniforms;
// Self-occlusion transmittance computed by froxel_self_occlusion pass.
// Value of 1.0 = full light, 0.0 = fully occluded by the medium itself.
@group(2) @binding(2) var froxelSelfOcclusionTexture: texture_3d<f32>;

@group(3) @binding(0) var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(3) @binding(1) var shadowMap0: texture_depth_2d;
@group(3) @binding(2) var shadowMap1: texture_depth_2d;
@group(3) @binding(3) var shadowMap2: texture_depth_2d;
@group(3) @binding(4) var shadowSampler: sampler_comparison;

struct AmbientLightUniforms {
    color: vec3<f32>,
    intensity: f32,
};

// Shader-specific CSM implementation using consolidated functions
fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    
    if (cascadeIndex == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
                directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascadeIndex == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
                directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    } else {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
                directionalLight.shadowParams.z, shadowMap2, shadowSampler);
    }
}

fn getShadowFactorForCascadeIndex(worldPos: vec3<f32>, idx: i32) -> f32 {
    // Call getShadowFactor with appropriate cascade shadow map
    if (idx == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
                directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (idx == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
                directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    } else {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
                directionalLight.shadowParams.z, shadowMap2, shadowSampler);
    }
}

fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(directionalLight.cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return getShadowFactorForCascadeIndex(worldPos,0);
    }
    
    let blendZone = 2.0; // 2 metros fijos, igual para todas las cascadas
    var cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    
    // Calcular split distance de la cascada actual
    var splitDist = directionalLight.cascadeSplits.x;
    if (cascadeIndex == 1) { splitDist = directionalLight.cascadeSplits.y; }
    else if (cascadeIndex == 2) { splitDist = directionalLight.cascadeSplits.z; }
    
    let blendStart = splitDist - blendZone;
    let blendFactor = saturate((viewSpaceDepth - blendStart) / blendZone);
    
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, viewSpaceDepth);
    }
    
    // Solo hacer doble lookup en la zona de blend real (2m)
    let shadowFactor1 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex);
    let shadowFactor2 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex + 1);
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let froxelCoord = vec3<i32>(globalId);
    
    // Bounds check
    if (froxelCoord.x >= i32(froxelParams.dimensions.x) ||
        froxelCoord.y >= i32(froxelParams.dimensions.y) ||
        froxelCoord.z >= i32(froxelParams.dimensions.z)) {
        return;
    }
    
    // Ambient light color e intensidad desde uniform
    let ambientColor = ambientLight.color;
    let ambientIntensity = ambientLight.intensity;
    let ambientScattering = ambientColor * ambientIntensity * volumetricSettings.ambientVolumetricIntensity;

    let directionalScattering = directionalLight.color * directionalLight.intensity;

    let froxelVS = froxelToViewSpace(
        globalId,
        froxelParams.dimensions.xyz,
        froxelParams.nearPlane,
        froxelParams.farPlane,
        camera.invProjection
    );
    let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
    let froxelWorldPos = tempFroxelWS.xyz / tempFroxelWS.w;
    let visibility = getShadowFactorCSMBlended(froxelWorldPos.xyz, abs(froxelVS.z));

    let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
    let Ldir = normalize(-directionalLight.position);

    let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

    // Forward scattering para god rays marcados
    // g = 0.7-0.8: god rays visibles
    // g = 0.85-0.9: god rays muy marcados (puede ser excesivo)
    let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95);
    let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
    let phaseMie = phaseHG(cosTheta, g);

    // Peso típico: casi todo Mie para shafts
    let phase = mix(phaseRayleigh, phaseMie, 0.9);

    // Self-occlusion: transmittance of the participating medium between this
    // froxel and the directional light source (computed by froxel_self_occlusion pass).
    // 1.0 = full light reaches here, 0.0 = fully occluded by the fog itself.
    let selfShadow = textureLoad(froxelSelfOcclusionTexture, froxelCoord, 0).r;

    // Aplicar phase function directamente (sin mezclar con isotropic)
    // Esto da god rays claros cuando miras hacia la luz directional
    let scattering = ambientScattering + (directionalScattering * visibility * selfShadow * phase);
    
    textureStore(froxelLightTexture, froxelCoord, vec4<f32>(scattering, 0.0));
}
