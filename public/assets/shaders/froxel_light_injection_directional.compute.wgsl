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

@group(3) @binding(0) var<uniform> directionalLight: DirectionalLightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

struct FroxelUniforms {
    dimensions: vec3<f32>,
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

struct DirectionalLightUniforms {
    direction: vec3<f32>,
    padding1: f32,
    color: vec3<f32>,
    intensity: f32,
    viewProjectionMatrix: mat4x4<f32>,
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
    
    // Read existing light (from ambient light injection)
    let existingLight = textureLoad(froxelLightTexture, froxelCoord, 0).rgb;
    
    // Get world space position of this froxel
    let worldPos = froxelToWorldSpace(globalId);
    
    // Transform to light shadow space
    let lightSpacePos = directionalLight.viewProjectionMatrix * vec4<f32>(worldPos, 1.0);
    var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;
    
    // Convert to shadow map UV coordinates (already done by matrix)
    let shadowUV = shadowCoord.xy;
    let shadowDepth = shadowCoord.z;
    
    // Check if position is within shadow map bounds
    if (shadowUV.x < 0.0 || shadowUV.x > 1.0 ||
        shadowUV.y < 0.0 || shadowUV.y > 1.0 ||
        shadowDepth < 0.0 || shadowDepth > 1.0) {
        // Outside shadow map - write existing light only
        textureStore(froxelLightOutput, froxelCoord, vec4<f32>(existingLight, 0.0));
        return;
    }
    
    // Sample shadow map with PCF
    var shadowFactor = 0.0;
    let texelSize = 1.0 / vec2<f32>(textureDimensions(shadowMap));
    
    // Simple 2x2 PCF
    for (var x = -0.5; x <= 0.5; x += 1.0) {
        for (var y = -0.5; y <= 0.5; y += 1.0) {
            let offset = vec2<f32>(x, y) * texelSize;
            shadowFactor += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + offset, shadowDepth);
        }
    }
    shadowFactor /= 4.0;
    
    // Calculate directional light contribution
    let lightColor = directionalLight.color * directionalLight.intensity;
    let directionalContribution = lightColor * shadowFactor * 2.0; // Boosted for visibility
    
    // Accumulate with existing light
    let totalLight = existingLight + directionalContribution;
    
    // Write to output texture
    textureStore(froxelLightOutput, froxelCoord, vec4<f32>(totalLight, 0.0));
}
