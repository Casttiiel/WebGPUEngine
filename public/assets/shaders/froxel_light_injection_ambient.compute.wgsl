#include "common/uniforms"
#include "common/structs"

// Froxel Light Injection - Ambient Light
// Fills scattering texture with ambient/skybox color based on density

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(1) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(1) @binding(1) var froxelLightTexture: texture_storage_3d<rgba16float, write>; // Write to LIGHT texture, not scattering

@group(2) @binding(0) var<uniform> ambientLight: AmbientLightUniforms;


struct FroxelUniforms {
    dimensions: vec3<u32>,
    padding1: u32,
    nearPlane: f32,
    farPlane: f32,
    logDepthScale: f32,
    logDepthBias: f32,
}

struct VolumetricUniforms {
    density: f32,
    scattering: f32,
    absorption: f32,
    anisotropy: f32,
    
    fogHeightFalloff: f32,
    fogDistanceFalloff: f32,
    noiseScale: f32,
    noiseStrength: f32,
    
    windDirection: vec3<f32>,
    windSpeed: f32,
    
    time: f32,
    maxDistance: f32,
    stepSize: f32,
    padding3: f32,
}

struct AmbientLightUniforms {
    color: vec3<f32>,
    intensity: f32,
};

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
    // Scattering = ambient color * intensity (density es manejada en el raymarch)
    let scattering = ambientColor * ambientIntensity;
    
    // Write to LIGHT texture (will be processed by scattering pass)
    textureStore(froxelLightTexture, froxelCoord, vec4<f32>(scattering, 0.0));
}
