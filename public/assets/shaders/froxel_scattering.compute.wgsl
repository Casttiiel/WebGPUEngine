// Froxel Scattering Pass - Compute Shader
// Propagates light through the 3D froxel grid using multiple scattering
// This is the third phase of the froxel volumetric pipeline

// Camera uniforms - @group(0)
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Froxel parameters - @group(1)
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Textures and samplers - @group(2)
@group(2) @binding(0) var froxelLightTexture: texture_3d<f32>;     // Input: light injection results
@group(2) @binding(1) var froxelDensityTexture: texture_3d<f32>;   // Input: density values
@group(2) @binding(2) var froxelScatteringTexture: texture_storage_3d<rgba16float, write>; // Output: scattered light
@group(2) @binding(3) var linearSampler: sampler;

// Uniform structures (shared with density pass)
struct CameraUniforms {
    view: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewProjection: mat4x4<f32>,
    inverseView: mat4x4<f32>,
    inverseProjection: mat4x4<f32>,
    position: vec3<f32>,
    padding1: f32,
    nearPlane: f32,
    farPlane: f32,
    fov: f32,
    aspectRatio: f32,
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
    padding1: f32,
    padding2: f32,
    padding3: f32,
}

// Convert froxel coordinates to world space position
fn froxelToWorldSpace(froxelCoord: vec3<u32>) -> vec3<f32> {
    let dimensions = vec3<f32>(froxelParams.dimensions);
    
    // Convert to normalized device coordinates [0,1]
    let ndc = vec3<f32>(froxelCoord) / dimensions;
    
    // Convert NDC to view space using logarithmic depth
    let viewZ = -mix(
        froxelParams.nearPlane,
        froxelParams.farPlane,
        pow(ndc.z, froxelParams.logDepthScale)
    );
    
    // Calculate view space X,Y from NDC
    let viewX = (ndc.x * 2.0 - 1.0) * -viewZ * tan(camera.fov * 0.5) * camera.aspectRatio;
    let viewY = (ndc.y * 2.0 - 1.0) * -viewZ * tan(camera.fov * 0.5);
    
    // Convert to world space
    let viewPos = vec4<f32>(viewX, viewY, viewZ, 1.0);
    let worldPos = camera.inverseView * viewPos;
    
    return worldPos.xyz;
}

// Convert world space position to froxel coordinates
fn worldToFroxelSpace(worldPos: vec3<f32>) -> vec3<f32> {
    // Transform to view space
    let viewPos = camera.view * vec4<f32>(worldPos, 1.0);
    let viewZ = -viewPos.z;
    
    // Convert to NDC coordinates
    let ndc_z = log(viewZ / froxelParams.nearPlane) / log(froxelParams.farPlane / froxelParams.nearPlane);
    let ndc_x = (viewPos.x / (viewZ * tan(camera.fov * 0.5) * camera.aspectRatio)) * 0.5 + 0.5;
    let ndc_y = (viewPos.y / (viewZ * tan(camera.fov * 0.5))) * 0.5 + 0.5;
    
    // Convert to froxel coordinates
    let dimensions = vec3<f32>(froxelParams.dimensions);
    return vec3<f32>(ndc_x, ndc_y, ndc_z) * dimensions;
}

// Henyey-Greenstein phase function for anisotropic scattering
fn phaseFunction(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * 3.14159265359 * pow(denom, 1.5));
}

// Sample froxel data with trilinear interpolation (for filterable textures)
fn sampleFroxel3D(texture: texture_3d<f32>, sampler: sampler, coord: vec3<f32>) -> vec4<f32> {
    let dimensions = vec3<f32>(froxelParams.dimensions);
    let uvw = coord / dimensions;
    return textureSampleLevel(texture, sampler, uvw, 0.0);
}

// Load froxel data directly (for unfilterable textures like density)
fn loadFroxel3D(texture: texture_3d<f32>, coord: vec3<f32>) -> vec4<f32> {
    let texelCoord = vec3<i32>(
        clamp(i32(coord.x), 0, i32(froxelParams.dimensions.x) - 1),
        clamp(i32(coord.y), 0, i32(froxelParams.dimensions.y) - 1),
        clamp(i32(coord.z), 0, i32(froxelParams.dimensions.z) - 1)
    );
    return textureLoad(texture, texelCoord, 0);
}

// Get neighboring froxel coordinates for scattering computation
fn getNeighborCoords(center: vec3<u32>) -> array<vec3<i32>, 6> {
    let centerI = vec3<i32>(center);
    return array<vec3<i32>, 6>(
        centerI + vec3<i32>(-1, 0, 0), // -X
        centerI + vec3<i32>(1, 0, 0),  // +X
        centerI + vec3<i32>(0, -1, 0), // -Y
        centerI + vec3<i32>(0, 1, 0),  // +Y
        centerI + vec3<i32>(0, 0, -1), // -Z
        centerI + vec3<i32>(0, 0, 1),  // +Z
    );
}

// Check if froxel coordinates are within bounds
fn isValidFroxel(coord: vec3<i32>) -> bool {
    let dimensions = vec3<i32>(froxelParams.dimensions);
    return coord.x >= 0 && coord.x < dimensions.x &&
           coord.y >= 0 && coord.y < dimensions.y &&
           coord.z >= 0 && coord.z < dimensions.z;
}

// Compute light scattering for current froxel
fn computeScattering(froxelCoord: vec3<u32>) -> vec4<f32> {
    let currentPos = froxelToWorldSpace(froxelCoord);
    
    // Sample current froxel density
    let froxelFloat = vec3<f32>(froxelCoord);
    let currentDensity = loadFroxel3D(froxelDensityTexture, froxelFloat).r;
    
    // If no density, no scattering
    if (currentDensity < 0.001) {
        return vec4<f32>(0.0);
    }
    
    // Sample injected light at current position
    let injectedLight = sampleFroxel3D(froxelLightTexture, linearSampler, froxelFloat).rgb;
    
    // Initialize accumulated scattered light
    var scatteredLight = vec3<f32>(0.0);
    
    // Get neighbor coordinates for light propagation
    let neighbors = getNeighborCoords(froxelCoord);
    
    // Propagate light from neighboring froxels
    for (var i = 0; i < 6; i++) {
        let neighborCoord = neighbors[i];
        
        if (!isValidFroxel(neighborCoord)) {
            continue;
        }
        
        let neighborFloat = vec3<f32>(neighborCoord);
        let neighborPos = froxelToWorldSpace(vec3<u32>(neighborCoord));
        
        // Sample neighbor's already scattered light (from previous iteration)
        let neighborLight = sampleFroxel3D(froxelLightTexture, linearSampler, neighborFloat).rgb;
        
        // Calculate light direction
        let lightDir = normalize(currentPos - neighborPos);
        let distance = length(currentPos - neighborPos);
        
        // Distance attenuation
        let attenuation = 1.0 / (1.0 + distance * distance * 0.01);
        
        // Phase function for anisotropic scattering
        // For now, assume isotropic scattering (g = 0)
        let phase = phaseFunction(0.0, 0.0); // Isotropic
        
        // Accumulate scattered light
        scatteredLight += neighborLight * attenuation * phase * volumetricSettings.scattering;
    }
    
    // In-scattering: combine injected light with scattered light
    let totalLight = injectedLight + scatteredLight * currentDensity;
    
    // Apply multiple scattering approximation
    let multipleScatteringFactor = 1.0 + 0.5 * currentDensity;
    let finalLight = totalLight * multipleScatteringFactor;
    
    return vec4<f32>(finalLight, currentDensity);
}

// Main compute shader entry point
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    // Check bounds
    if (globalId.x >= froxelParams.dimensions.x || 
        globalId.y >= froxelParams.dimensions.y || 
        globalId.z >= froxelParams.dimensions.z) {
        return;
    }
    
    // SIMPLIFIED: No scattering calculation - just write basic uniform light
    // This eliminates all complex neighbor sampling and light propagation
    
    // Simple uniform light throughout the entire volume
    let basicLight = vec3<f32>(0.5, 0.6, 0.8); // Soft blue-white light
    
    // Write basic light to scattering texture (no complex calculations)
    textureStore(froxelScatteringTexture, globalId, vec4<f32>(basicLight, 1.0));
}
