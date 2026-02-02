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

@group(3) @binding(0) var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

struct AmbientLightUniforms {
    color: vec3<f32>,
    intensity: f32,
};

// Shader-specific CSM implementation using consolidated functions
fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    
    if (cascadeIndex == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
                directionalLight.shadowParams.z, shadowMap, shadowSampler);
    } else if (cascadeIndex == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
                directionalLight.shadowParams.z, shadowMap, shadowSampler);
    } else {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
                directionalLight.shadowParams.z, shadowMap, shadowSampler);
    }
}

fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(directionalLight.cascadeSplits.w);
    let blendRegion = 0.1;
    
    var cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    var blendFactor = 0.0;
    
    if (cascadeIndex == 0 && viewSpaceDepth > directionalLight.cascadeSplits.x * (1.0 - blendRegion)) {
        let splitDist = directionalLight.cascadeSplits.x;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    } else if (cascadeIndex == 1 && cascadeCount > 2 && viewSpaceDepth > directionalLight.cascadeSplits.y * (1.0 - blendRegion)) {
        let splitDist = directionalLight.cascadeSplits.y;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    }
    
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, viewSpaceDepth);
    }
    
    let shadowFactor1 = getShadowFactorCSM(worldPos, viewSpaceDepth);
    let nextCascadeDepth = viewSpaceDepth + 0.1;
    let shadowFactor2 = getShadowFactorCSM(worldPos, nextCascadeDepth);
    
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
    let gg = g * g;
    let denom = pow(1.0 + gg - 2.0 * g * cosTheta, 1.5);
    return (1.0 - gg) / max(denom, 1e-4);
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
    let ambientScattering = ambientColor * ambientIntensity * 0.05;

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
    let visibility = getShadowFactorCSMBlended(froxelWorldPos.xyz, froxelVS.z);

    let V = normalize(camera.cameraPosition - froxelWorldPos);
    let Ldir = normalize(-directionalLight.position);

    let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

    let g = 0.7; // prueba 0.7..0.85
    let ph = phaseHG(cosTheta, g);
    let isotropic = 1.0;
    let phase = mix(isotropic, ph, 0.4) * 0.3;

    let scattering = ambientScattering + (directionalScattering * visibility * phase);
    
    textureStore(froxelLightTexture, froxelCoord, vec4<f32>(scattering, 0.0));
}
