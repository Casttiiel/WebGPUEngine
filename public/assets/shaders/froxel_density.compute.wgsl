// Froxel Density Computation Shader
// Calculates fog density distribution in 3D frustum voxels
// Used in modern volumetric scattering systems (UE5, Unity HDRP, Frostbite)

struct FroxelUniforms {
  froxelDimensions: vec3<u32>,   // Grid dimensions (160, 90, 64)
  _pad1: u32,
  nearPlane: f32,                // Camera near plane
  farPlane: f32,                 // Camera far plane
  _pad2: vec2<f32>,
}

struct VolumetricUniforms {
  fogDensity: f32,               // Base fog density
  scatteringCoeff: f32,          // Light scattering coefficient
  absorptionCoeff: f32,          // Light absorption coefficient
  phaseG: f32,                   // Henyey-Greenstein phase function parameter
  
  fogHeight: f32,                // Height at which fog density starts falling off
  fogHeightFalloff: f32,         // Exponential falloff rate with height
  intensity: f32,                // Overall volumetric intensity
  _pad3: f32,
}

struct CameraUniforms {
  viewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  viewProjectionMatrix: mat4x4<f32>,
  invViewMatrix: mat4x4<f32>,
  invProjectionMatrix: mat4x4<f32>,
  invViewProjectionMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  _pad1: f32,
  cameraDirection: vec3<f32>,
  _pad2: f32,
}

// Bind groups
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<r32float, write>;

// Noise texture for realistic fog variation (2D texture, not 3D)
@group(2) @binding(1) var noiseTexture: texture_2d<f32>;
@group(2) @binding(2) var noiseSampler: sampler;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let froxelCoord = globalId.xyz;
  
  // Bounds check
  if (froxelCoord.x >= froxelParams.froxelDimensions.x || 
      froxelCoord.y >= froxelParams.froxelDimensions.y || 
      froxelCoord.z >= froxelParams.froxelDimensions.z) {
    return;
  }

  // DEBUG: Higher density for visibility testing
  let density = 0.4; // Higher density to ensure visibility
  
  // Store density in 3D texture (R32F format)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(density, 0.0, 0.0, 0.0));
}
