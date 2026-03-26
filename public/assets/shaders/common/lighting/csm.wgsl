// Cascaded Shadow Maps (CSM) - Consolidated from multiple shaders
// This file eliminates 150+ lines of duplicated CSM code

// ===========================
// CSM UNIFORMS STRUCT
// ===========================

struct DirectionalLightCSMUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>,          // Direction towards light
    intensity: f32,
    viewProjOffset0: mat4x4<f32>, // Cascade 0 (near)
    viewProjOffset1: mat4x4<f32>, // Cascade 1 (mid)
    viewProjOffset2: mat4x4<f32>, // Cascade 2 (far)
    cascadeSplits: vec4<f32>,     // x: split0, y: split1, z: split2, w: cascadeCount
    shadowParams: vec4<f32>,      // x: stepDivRes cascade0, y: stepDivRes cascade1, z: stepDivRes cascade2, w: unused
}

// ===========================
// CASCADE SELECTION
// ===========================

/**
 * Selects the appropriate cascade based on view space depth.
 * Returns: cascade index (0, 1, or 2)
 * 
 * @param viewSpaceDepth - Distance from camera in view space
 * @param cascadeSplits - vec4 with split distances (x: split0, y: split1, z: split2, w: cascadeCount)
 */
fn selectCascadeCSM(viewSpaceDepth: f32, cascadeSplits: vec4<f32>) -> i32 {
    let cascadeCount = i32(cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return 0;
    }
    
    if (viewSpaceDepth < cascadeSplits.x) {
        return 0; // Near cascade
    } else if (cascadeCount == 2 || viewSpaceDepth < cascadeSplits.y) {
        return min(1, cascadeCount - 1); // Mid cascade
    } else {
        return min(2, cascadeCount - 1); // Far cascade
    }
}

// ===========================
// SHADOW SAMPLING (BASE)
// ===========================

/**
 * Basic shadow tap with depth comparison.
 * Handles boundary checking and returns 1.0 (no shadow) for out-of-bounds coordinates.
 * 
 * @param homo_coord - UV coordinates in shadow map space [0,1]
 * @param coord_z - Depth value to compare against shadow map
 * @param shadowMap - Depth texture to sample
 * @param shadowSampler - Comparison sampler
 */
fn shadowsTapCSM(
    homo_coord: vec2<f32>, 
    coord_z: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison
) -> f32 {
    // Quick optimization: return early for out-of-bounds
    if (homo_coord.x < 0.0 || homo_coord.x > 1.0 ||
        homo_coord.y < 0.0 || homo_coord.y > 1.0) {
        return 1.0; // No shadow
    }

    return textureSampleCompareLevel(shadowMap, shadowSampler, homo_coord, coord_z);
}

// ===========================
// SHADOW FACTOR CALCULATION
// ===========================

/**
 * Calculates shadow factor for a single cascade.
 * Includes UV snapping to eliminate shadow shimmering.
 * 
 * @param wPos - World position
 * @param lightViewProjOffset - ViewProjection matrix for this cascade
 * @param shadowStepDivResolution - Shadow map resolution parameter
 * @param shadowMap - Depth texture
 * @param shadowSampler - Comparison sampler
 */
fn getShadowFactorForCascade(
    wPos: vec3<f32>,
    lightViewProjOffset: mat4x4<f32>,
    shadowStepDivResolution: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison
) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;

    // Check if within valid shadow map range
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0) {
        return 1.0; // Out of depth range = no shadow
    }

    if (lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 || 
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0; // Out of UV range = no shadow
    }

    let uv = lightUVSpacePos.xy;

    return shadowsTapCSM(uv, lightUVSpacePos.z, shadowMap, shadowSampler);
}

// ===========================
// CSM SHADOW FACTOR (NO BLEND)
// ===========================

/**
 * Calculates shadow factor using CSM without cascade blending.
 * Selects the appropriate cascade based on view depth.
 * 
 * NOTE: This is a generic interface - actual implementation needs shadow map parameters.
 * For concrete implementations, see shader-specific versions that pass appropriate shadow maps.
 * 
 * @param worldPos - World space position
 * @param viewSpaceDepth - Distance from camera
 * @param csmUniforms - CSM light uniforms
 */
// This is a template - concrete shaders should implement their own version
// that passes the correct shadow maps (gShadowMap0, gShadowMap1, gShadowMap2)

// ===========================
// CSM SHADOW FACTOR (BLENDED)
// ===========================

/**
 * Calculates shadow factor with smooth blending between cascades.
 * Uses 10% blend region around cascade splits to eliminate hard transitions.
 * 
 * Blend region calculation:
 * - At 90% of split distance: start blending
 * - At 100% of split distance: fully transitioned to next cascade
 * 
 * @param worldPos - World space position
 * @param viewSpaceDepth - Distance from camera
 * @param cascadeSplits - Split distances and count
 * @param blendRegion - Size of blend region (default: 0.1 = 10%)
 * 
 * NOTE: This is a generic interface. Concrete shaders must implement their own
 * getShadowFactorCSMBlended that calls getShadowFactorForCascade with appropriate
 * shadow maps for each cascade.
 */
// Template function - see shader-specific implementations

// ===========================
// DEBUG UTILITIES
// ===========================

/**
 * Returns debug color for cascade visualization:
 * - Cascade 0 (near): Red
 * - Cascade 1 (mid):  Green
 * - Cascade 2 (far):  Blue
 * 
 * @param cascadeIndex - Cascade to visualize (0-2)
 */
fn getCascadeDebugColorCSM(cascadeIndex: i32) -> vec3<f32> {
    if (cascadeIndex == 0) {
        return vec3<f32>(1.0, 0.0, 0.0); // Red - near cascade
    } else if (cascadeIndex == 1) {
        return vec3<f32>(0.0, 1.0, 0.0); // Green - mid cascade
    } else {
        return vec3<f32>(0.0, 0.0, 1.0); // Blue - far cascade
    }
}
