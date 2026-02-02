// Shadow mapping utilities - common functions
// Level 3: Depends on core/constants

#include "common/core/constants"

// Single shadow map tap with adaptive bias
fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32, normal: vec3<f32>, lightDir: vec3<f32>, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison) -> f32 {
    // Quick bounds check
    if (homo_coord.x < 0.0 || homo_coord.x > 1.0 ||
        homo_coord.y < 0.0 || homo_coord.y > 1.0) {
        return 1.0;
    }
    
    // Adaptive bias based on surface angle
    let cosTheta = clamp(dot(normal, -lightDir), 0.001, 1.0);
    let tanTheta = sqrt(1.0 - cosTheta * cosTheta) / cosTheta;
    let slopeBias = clamp(tanTheta * 0.0001, 0.0, 0.001);
    let baseBias = 0.000001;
    let totalBias = baseBias + slopeBias;
    
    return textureSampleCompareLevel(shadowMap, shadowSampler, homo_coord, baseBias);
}

// PCF shadow sampling with 3x3 kernel
fn getShadowFactor(wPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool, cascadeIndex: i32) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    
    // Out of bounds check
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    // PCF 3x3 filtering
    let texelSize = lightShadowStepDivResolution;
    var shadow = 0.0;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
            let offset = vec2<f32>(f32(dx), f32(dy)) * texelSize;
            shadow += textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy + offset, lightUVSpacePos.z);
        }
    }
    shadow = shadow / 9.0;
    return shadow;
}
