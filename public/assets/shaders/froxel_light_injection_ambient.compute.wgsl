#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelLightTexture: texture_storage_3d<rgba16float, write>;
@group(2) @binding(1) var<uniform> ambientLight: AmbientLightUniforms;

@group(3) @binding(0) var<uniform> directionalLight: DirectionalLightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;


struct FroxelUniforms {
  dimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  stepSize: f32
}

struct AmbientLightUniforms {
    color: vec3<f32>,
    intensity: f32,
};

struct DirectionalLightUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>, // Direction towards light
    intensity: f32,
    viewProjOffset0: mat4x4<f32>, // Cascade 0 (near)
    viewProjOffset1: mat4x4<f32>, // Cascade 1 (mid)
    viewProjOffset2: mat4x4<f32>, // Cascade 2 (far)
    cascadeSplits: vec4<f32>,     // x: split0, y: split1, z: split2, w: cascadeCount
    shadowParams: vec4<f32>,      // x: shadowStep, y: invResolution, z: stepDivResolution, w: unused
}

fn froxelZToViewZLinear(zSlice: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
    let z01 = (f32(zSlice) + 0.5) / f32(slices);
    return nearZ + z01 * (farZ - nearZ); // distancia positiva
}

fn froxelZToViewZLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ * pow(farZ / max(nearZ, 1e-6), z01);
}

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    // ⚠️ aquí NO flip Y (solo si tu engine lo necesita)
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / max(rayH.w, 1e-8));
}

// ✅ Froxel coord -> View space position
fn froxelToViewSpace(froxel: vec3<u32>) -> vec3<f32> {
    let dimsU = vec3<u32>(froxelParams.dimensions.xyz);

    // uv centro del tile
    var uv = (vec2<f32>(froxel.xy) + vec2<f32>(0.5)) / froxelParams.dimensions.xy;
    uv.y = 1 - uv.y;
    // view ray
    let rayVS = computeViewRayFromUV(uv);

    // viewZ (distancia positiva)
    let viewDist = froxelZToViewZLog(froxel.z, dimsU.z, froxelParams.nearPlane, froxelParams.farPlane);

    let t = -viewDist / min(rayVS.z, -1e-6);

    return rayVS * t;
}

fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(directionalLight.cascadeSplits.w);
    
    // Región de blend (10% alrededor del split)
    let blendRegion = 0.1;
    
    // Determinar cascadas y factor de blend
    var cascadeIndex = selectCascade(viewSpaceDepth);
    var blendFactor = 0.0;
    
    // Calcular blend factor si estamos cerca de un split
    if (cascadeIndex == 0 && viewSpaceDepth > directionalLight.cascadeSplits.x * (1.0 - blendRegion)) {
        let splitDist = directionalLight.cascadeSplits.x;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    } else if (cascadeIndex == 1 && cascadeCount > 2 && viewSpaceDepth > directionalLight.cascadeSplits.y * (1.0 - blendRegion)) {
        let splitDist = directionalLight.cascadeSplits.y;
        let blendStart = splitDist * (1.0 - blendRegion);
        blendFactor = (viewSpaceDepth - blendStart) / (splitDist - blendStart);
    }
    
    // Si no hay blend, retornar shadow factor simple
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, viewSpaceDepth);
    }
    
    // Calcular shadow factor de ambas cascadas
    let shadowFactor1 = getShadowFactorCSM(worldPos, viewSpaceDepth);
    
    // Forzar siguiente cascada
    let nextCascadeDepth = viewSpaceDepth + 0.1;
    let shadowFactor2 = getShadowFactorCSM(worldPos, nextCascadeDepth);
    
    // Blend suave entre cascadas
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

fn selectCascade(viewSpaceDepth: f32) -> i32 {
    let cascadeCount = i32(directionalLight.cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return 0;
    }
    
    if (viewSpaceDepth < directionalLight.cascadeSplits.x) {
        return 0; // Near cascade
    } else if (cascadeCount == 2 || viewSpaceDepth < directionalLight.cascadeSplits.y) {
        return min(1, cascadeCount - 1); // Mid cascade
    } else {
        return min(2, cascadeCount - 1); // Far cascade
    }
}

fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    // Seleccionar cascada
    let cascadeIndex = selectCascade(viewSpaceDepth);
    
    // Llamar a getShadowFactor con la cascada apropiada + cascadeIndex para PCF adaptativo
    if (cascadeIndex == 0) {
        return getShadowFactor(
            worldPos,
            directionalLight.viewProjOffset0,
            0 // Cascada 0: 16 samples
        );
    } else if (cascadeIndex == 1) {
        return getShadowFactor(
            worldPos,
            directionalLight.viewProjOffset1,
            1 // Cascada 1: 9 samples
        );
    } else {
        return getShadowFactor(
            worldPos,
            directionalLight.viewProjOffset2,
            2 // Cascada 2: 4 samples
        );
    }
}

fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, cascadeIndex: i32) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;

    // Verificar que esté dentro del rango válido de la shadow map
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0) {
        return 1.0; // Fuera del rango de profundidad = sin sombra
    }

    if (lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 || 
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0; // Fuera del rango UV = sin sombra
    }
    
    // CRÍTICO: Snapear UV base al centro de texel ANTES del PCF kernel
    // Esto elimina micro-shifts subpixel cuando la cámara se mueve
    let texelSize = directionalLight.shadowParams.z / 1.5; // Aproximadamente 1/resolution
    let snappedUV = (floor(lightUVSpacePos.xy / texelSize) + 0.5) * texelSize;

    return shadowsTap(snappedUV, lightUVSpacePos.z);
}

fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32) -> f32 {
    // Quick optimization: clamp coordinates instead of branching
    if (homo_coord.x < 0.0 || homo_coord.x > 1.0 ||
        homo_coord.y < 0.0 || homo_coord.y > 1.0) {
        return 1.0;
    }

    return textureSampleCompareLevel(shadowMap, shadowSampler, homo_coord, coord_z);
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

    let froxelVS = froxelToViewSpace(globalId);
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
