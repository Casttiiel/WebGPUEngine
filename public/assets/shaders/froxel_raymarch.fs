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
@group(1) @binding(0) var gBufferDepthTexture: texture_depth_2d;
@group(1) @binding(1) var depthSampler: sampler;

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    position: vec3<f32>,
    screenSize: vec2<f32>,
    cameraFront: vec3<f32>,
    cameraZFar: f32,
    invProjection: mat4x4<f32>,
}

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

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) worldPos: vec3<f32>,
}

// Convert world space position to froxel coordinates (normalized [0,1])
fn worldSpaceToFroxel(worldPos: vec3<f32>) -> vec3<f32> {
    // Transform to view space
    let viewPos = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let viewZ = -viewPos.z;
    
    // Simple bounds checking
    let nearPlane = 0.1;
    let farPlane = 100.0;
    
    // Check bounds
    if (viewZ < nearPlane || viewZ > farPlane) {
        return vec3<f32>(-1.0); // Invalid coordinate
    }
    
    // Simple linear depth mapping
    let ndc_z = (viewZ - nearPlane) / (farPlane - nearPlane);
    
    // Simple screen space mapping
    let halfTanFov = tan(60 * 0.5);//camera.fov
    let ndc_x = (viewPos.x / (viewZ * halfTanFov * (camera.screenSize.x / camera.screenSize.y))) * 0.5 + 0.5;//camera.aspectRatio
    let ndc_y = (-viewPos.y / (viewZ * halfTanFov)) * 0.5 + 0.5;
    
    // Clamp to valid range
    let clampedX = clamp(ndc_x, 0.0, 1.0);
    let clampedY = clamp(ndc_y, 0.0, 1.0);
    let clampedZ = clamp(ndc_z, 0.0, 1.0);
    
    return vec3<f32>(clampedX, clampedY, clampedZ);
}

// Sample froxel data with bounds checking
fn sampleFroxelData(froxelCoord: vec3<f32>) -> vec4<f32> {
    // Bounds check
    if (froxelCoord.x < 0.0 || froxelCoord.x > 1.0 ||
        froxelCoord.y < 0.0 || froxelCoord.y > 1.0 ||
        froxelCoord.z < 0.0 || froxelCoord.z > 1.0) {
        return vec4<f32>(0.0); // Outside froxel grid
    }
    
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

// Calculate ray marching parameters
fn calculateRayParams(viewRay: vec3<f32>) -> vec2<f32> {
    // Transform view ray to world space
    let worldRay = normalize((camera.viewMatrix * vec4<f32>(viewRay, 0.0)).xyz);
    
    // Calculate intersection with froxel volume bounds
    let rayStart = camera.position;
    let rayDir = worldRay;
    
    // Use reasonable ray marching distances
    let tNear = 0.1;  // Start a bit in front of camera
    let tFar = 100.0; // Fixed reasonable distance for debugging
    
    return vec2<f32>(tNear, tFar);
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // Camera setup
    let cameraPos = camera.position.xyz;
    let viewDir = normalize(input.worldPos.xyz - cameraPos);
    
    return vec4<f32>(input.worldPos.y % 1.0);

    // Ray marching setup
    let rayStart = cameraPos;
    let rayEnd = input.worldPos.xyz;
    let rayDir = normalize(rayEnd - rayStart);
    let rayLength = length(rayEnd - rayStart);
    
    // Clamp ray length to reasonable distance
    let maxDistance = 100.0;
    let actualRayLength = min(rayLength, maxDistance);
    
    // Ray marching with proper parameters for volumetrics
    let numSteps = 32; // Increase steps for better quality
    let stepSize = actualRayLength / f32(numSteps);
    
    var scatteredLight = vec3<f32>(0.0);
    var transmittance = 1.0;
    
    // Debug: Count how many steps have data
    var stepsWithData = 0;
    var totalScattering = 0.0;
    
    for (var i = 0; i < numSteps; i++) {
        let t = f32(i) * stepSize;
        let samplePos = rayStart + rayDir * t;
        
        // Convert to froxel coordinates
        let froxelCoord = worldSpaceToFroxel(samplePos);
        
        // Check bounds
        if (froxelCoord.x < 0.0 || froxelCoord.x > 1.0 ||
            froxelCoord.y < 0.0 || froxelCoord.y > 1.0 ||
            froxelCoord.z < 0.0 || froxelCoord.z > 1.0) {
            continue;
        }
        
        let froxelData = sampleFroxelData(froxelCoord);
        let density = froxelData.a;
        let scattering = froxelData.rgb;
        
        if (density > 0.0 || length(scattering) > 0.0) {
            stepsWithData++;
            totalScattering += length(scattering);
        }
        
        // Accumulate scattering
        scatteredLight += scattering * transmittance * stepSize;
        
        // Update transmittance
        let extinction = density * stepSize;
        transmittance *= exp(-extinction);
    }
    
    // Final volumetric rendering with boosted visibility
    if (stepsWithData > 0) {
        // Apply volumetric scattering with higher intensity for visibility
        let intensity = 5.0; // Much higher for visibility
        let finalScattering = scatteredLight * intensity;
        let finalAlpha = (1.0 - transmittance) * 0.8; // Higher alpha for visibility
        
        // Ensure minimum visibility
        let minVisibility = vec3<f32>(0.05); // Minimum visible threshold
        let visibleScattering = max(finalScattering, minVisibility);
        let visibleAlpha = max(finalAlpha, 0.2); // Minimum alpha
        
        // Clamp values but keep them visible
        let clampedScattering = clamp(visibleScattering, vec3<f32>(0.0), vec3<f32>(1.0));
        let clampedAlpha = clamp(visibleAlpha, 0.2, 0.8);
        
        // Return visible volumetric color
        return vec4<f32>(clampedScattering, clampedAlpha);
    } else {
        // No volumetric contribution - return transparent
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
}
