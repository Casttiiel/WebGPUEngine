#include "common/uniforms"
#include "common/structs"
#include "common/utils"

// Froxel Ray Marching Fragment Shader
// Final phase: Projects 3D froxel data onto screen pixels
// This is where the volumetric effects become visible

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(2) var<uniform> volumetricSettings: VolumetricUniforms;
@group(0) @binding(3) var froxelDensityTexture: texture_3d<f32>;
@group(0) @binding(4) var froxelScatteringTexture: texture_3d<f32>;
@group(0) @binding(5) var linearSampler: sampler;

// G-Buffer depth for proper ray termination
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;



struct FroxelUniforms {
    dimensions: vec3<u32>,     // Froxel grid dimensions (160, 90, 64)
    padding1: u32,
    nearPlane: f32,            // Camera near plane
    farPlane: f32,             // Camera far plane
    logDepthScale: f32,        // Logarithmic depth scaling factor
    logDepthBias: f32,         // Logarithmic depth bias
}

struct VolumetricUniforms {
    density: f32,              // Base fog density
    scattering: f32,           // Scattering coefficient
    absorption: f32,           // Absorption coefficient
    anisotropy: f32,           // Phase function anisotropy (-1 to 1)
    
    fogHeightFalloff: f32,     // Height-based density falloff
    fogDistanceFalloff: f32,   // Distance-based density falloff
    noiseScale: f32,           // 3D noise scale
    noiseStrength: f32,        // Noise influence strength
    
    windDirection: vec3<f32>,  // Wind direction for noise animation
    windSpeed: f32,            // Wind speed multiplier
    
    time: f32,                 // Animation time
    maxDistance: f32,          // Maximum ray marching distance
    stepSize: f32,             // Ray marching step size
    padding3: f32,
}

// Convert world space position to froxel coordinates (normalized [0,1])
fn worldSpaceToFroxel(worldPos: vec3<f32>) -> vec3<f32> {
    // Transform to view space
    let viewPos = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let viewZ = -viewPos.z;
    
    // Use froxel parameters for consistency
    let nearPlane = froxelParams.nearPlane;
    let farPlane = froxelParams.farPlane;
    
    // Check bounds using froxel parameters
    if (viewZ < nearPlane || viewZ > farPlane) {
        return vec3<f32>(-1.0); // Invalid coordinate
    }
    
    // Use logarithmic depth mapping to match froxel system
    let linearDepth = (viewZ - nearPlane) / (farPlane - nearPlane);
    let ndc_z = pow(linearDepth, 1.0 / froxelParams.logDepthScale);
    
    // Screen space projection using proper camera parameters
    let aspectRatio = camera.screenSize.x / camera.screenSize.y;
    let tanHalfFov = tan(radians(60.0) * 0.5); // Convert degrees to radians
    
    let ndc_x = (viewPos.x / (-viewZ * tanHalfFov * aspectRatio)) * 0.5 + 0.5;
    let ndc_y = (viewPos.y / (-viewZ * tanHalfFov)) * 0.5 + 0.5;
    
    // Clamp to valid range
    let clampedX = clamp(ndc_x, 0.0, 1.0);
    let clampedY = clamp(ndc_y, 0.0, 1.0);
    let clampedZ = clamp(ndc_z, 0.0, 1.0);
    
    return vec3<f32>(clampedX, clampedY, clampedZ);
}

// Sample froxel data with bounds checking
fn sampleFroxelData(froxelCoord: vec3<f32>) -> vec4<f32> {
    // Sample scattered light (RGB) using sampling, density using direct load
    let scatteredLight = textureSampleLevel(froxelScatteringTexture, linearSampler, froxelCoord, 0.0).rgb;
    
    // Convert normalized coordinates to integer texel coordinates for textureLoad
    let texelCoord = vec3<i32>(
        i32(froxelCoord.x * f32(froxelParams.dimensions.x)),
        i32(froxelCoord.y * f32(froxelParams.dimensions.y)),
        i32(froxelCoord.z * f32(froxelParams.dimensions.z))
    );
    let density = textureLoad(froxelDensityTexture, texelCoord, 0).r;
    
    return vec4<f32>(scatteredLight, density);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let sceneDepth = textureSample(gLinearDepth, samplerGBuffer, uv).x;

    if (sceneDepth > 0.999) {
        return vec4<f32>(1.0);
    }

    // Camera setup
    let cameraPos = camera.cameraPosition.xyz;
    let worldPos = getWorldCoords(uv, sceneDepth, camera);
    let viewDir = normalize(worldPos.xyz - cameraPos);
    
    // Calculate distances
    let worldSpaceDistance = length(worldPos.xyz - cameraPos);
    let viewDirLength = length(viewDir);
    
    // Check for invalid view direction
    if (viewDirLength < 0.001) {
        return vec4<f32>(0.0);
    }

    // Ray marching setup
    let rayStart = cameraPos;
    let rayEnd = worldPos.xyz;
    let rayDir = normalize(rayEnd - rayStart);
    let rayLength = length(rayEnd - rayStart);
    
    // Ray length limited by geometry intersection
    let actualRayLength = rayLength;
    
    // Ray marching parameters
    let numSteps = 32;
    let stepSize = actualRayLength / f32(numSteps);
    
    var scatteredLight = vec3<f32>(0.0);
    var transmittance = 1.0;
    
    for (var i = 0; i < numSteps; i++) {
        let t = f32(i) * stepSize;
        let samplePos = rayStart + rayDir * t;
        
        // Early exit if transmittance is too low
        if (transmittance < 0.01) {
            break;
        }
                
        // Convert to froxel coordinates
        let froxelCoord = worldSpaceToFroxel(samplePos);
        
        // Bounds checking
        if (froxelCoord.x < 0.0 || froxelCoord.x > 1.0 ||
            froxelCoord.y < 0.0 || froxelCoord.y > 1.0 ||
            froxelCoord.z < 0.0 || froxelCoord.z > 1.0) {
            continue;
        }
        
        let froxelData = sampleFroxelData(froxelCoord);
        let density = froxelData.a;
        let scattering = froxelData.rgb;
        
        // Validate sample data for NaN/Inf
        if (density != density || any(scattering != scattering)) {
            continue;
        }
        
        // Clamp extreme values
        let clampedDensity = clamp(density, 0.0, 10.0);
        let clampedScattering = clamp(scattering, vec3<f32>(0.0), vec3<f32>(10.0));
        

        
        // Accumulate scattering
        scatteredLight += clampedScattering * transmittance * stepSize;
        
        // Update transmittance with clamped density
        let extinction = clampedDensity * stepSize;
        transmittance *= exp(-extinction);
    }
    
    // Final volumetric rendering
    let finalScattering = scatteredLight * volumetricSettings.scattering;
    let finalAlpha = (1.0 - transmittance);
    
    // Safety clamping
    let clampedScattering = clamp(finalScattering, vec3<f32>(0.0), vec3<f32>(1.0));
    let clampedAlpha = clamp(finalAlpha, 0.0, 1.0);
    
    // Return visible volumetric color
    return vec4<f32>(clampedScattering, clampedAlpha);
}
