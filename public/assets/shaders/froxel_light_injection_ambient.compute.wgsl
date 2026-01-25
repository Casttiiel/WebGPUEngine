#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(1) @binding(0) var froxelLightTexture: texture_storage_3d<rgba16float, write>;
@group(1) @binding(1) var<uniform> ambientLight: AmbientLightUniforms;


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
    let scattering = ambientColor * ambientIntensity * 0.05;
    
    textureStore(froxelLightTexture, froxelCoord, vec4<f32>(scattering, 0.0));
}
