#include "common/uniforms"
#include "common/structs"

// Froxel Light Injection - Directional Light
// Injects directional light color into froxels with shadow testing

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // Read existing light
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // Write accumulated light

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

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

struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,// 16 bytes (0-15)
    position: vec3<f32>,         // 12 bytes (16-27)
    intensity: f32,              // 4 bytes  (28-31)
    viewProjOffset: mat4x4<f32>, // 64 bytes (32-95)
    radius: f32,                 // 4 bytes  (96-99)
    shadowStep: f32,             // 4 bytes  (100-103)
    shadowInverseResolution: f32, // 4 bytes (104-107)
    shadowStepDivResolution: f32, // 4 bytes (108-111)
    startFalloff: f32,           // 4 bytes  (112-115)
    padding: vec3<f32>,          // 12 bytes (116-127)
    extraPadding: f32,           // 4 bytes  (128-131) para llegar a 144 bytes
}

// Convert froxel index to world space position
fn froxelToWorldSpace(froxelCoord: vec3<u32>) -> vec3<f32> {
    let dimensions = vec3<f32>(froxelParams.dimensions);
    let normalizedCoord = (vec3<f32>(froxelCoord) + 0.5) / dimensions;
    
    // Convert normalized coords to NDC
    let ndc_x = normalizedCoord.x * 2.0 - 1.0;
    let ndc_y = normalizedCoord.y * 2.0 - 1.0;
    
    // Use logarithmic depth distribution for Z
    let linearDepth = pow(normalizedCoord.z, froxelParams.logDepthScale);
    let viewZ = froxelParams.nearPlane + linearDepth * (froxelParams.farPlane - froxelParams.nearPlane);
    
    // Map viewZ to NDC depth [0, 1]
    let ndcZ = (viewZ - froxelParams.nearPlane) / (froxelParams.farPlane - froxelParams.nearPlane);
    
    // Reconstruct clip space position
    let clipPos = vec4<f32>(ndc_x, ndc_y, ndcZ * 2.0 - 1.0, 1.0);
    
    // Transform to view space using inverse projection
    var viewPos = camera.invProjection * clipPos;
    viewPos = viewPos / viewPos.w;
    
    // Transform to world space using inverse view
    let worldPos = camera.invViewProjection * vec4<f32>(viewPos.xyz, 1.0);
    return worldPos.xyz / worldPos.w;
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
    
    // Read existing light
    let existingLight = textureLoad(froxelLightTexture, froxelCoord, 0).rgb;
    
    // Get world space position of this froxel
    let worldPos = froxelToWorldSpace(globalId);

    // Attenuation
    let light_dir_full = light.position.xyz - worldPos;
    let distance_to_light = abs(length(light_dir_full));
    let normalized_distance = max(distance_to_light - light.startFalloff, 0.0) / (light.radius - light.startFalloff);
    var att = saturate(1.0 - normalized_distance);
    
    let pointContribution = light.color.xyz * att * light.intensity;
    
    // Accumulate with existing light
    let totalLight = existingLight + pointContribution;
    
    // Write to output texture
    textureStore(froxelLightOutput, froxelCoord, vec4<f32>(totalLight, 0.0));
}
