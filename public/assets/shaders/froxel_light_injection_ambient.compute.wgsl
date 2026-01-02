#include "common/uniforms"
#include "common/structs"

// Froxel Light Injection - Ambient Light
// Fills scattering texture with ambient/skybox color based on density

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(2) var<uniform> volumetricSettings: VolumetricUniforms;

@group(1) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(1) @binding(1) var froxelScatteringTexture: texture_storage_3d<rgba16float, write>;

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

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let froxelCoord = vec3<i32>(globalId);
    
    // Bounds check
    if (froxelCoord.x >= i32(froxelParams.dimensions.x) ||
        froxelCoord.y >= i32(froxelParams.dimensions.y) ||
        froxelCoord.z >= i32(froxelParams.dimensions.z)) {
        return;
    }
    
    // Read density from density texture
    let density = textureLoad(froxelDensityTexture, froxelCoord, 0).r;
    
    // Ambient light color (neutral white, tinted by IBL in practice)
    let ambientColor = vec3<f32>(1.0, 1.0, 1.0);
    
    // Use volumetric intensity setting (should match ambient light settings)
    let ambientIntensity = volumetricSettings.scattering; // Using scattering coefficient as intensity
    
    // Scattering = ambient color * density * intensity
    let scattering = ambientColor * density * ambientIntensity;
    
    // Write to scattering texture
    textureStore(froxelScatteringTexture, froxelCoord, vec4<f32>(scattering, 0.0));
}
