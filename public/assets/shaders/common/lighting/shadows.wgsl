// Shadow mapping utilities - common functions
// Level 3: Depends on core/constants

#include "common/core/constants"

// PCF shadow sampling with 3x3 kernel
fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
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

    // PCF 5x5 filtering
    let texelSize = lightShadowStepDivResolution;
    var shadow = 0.0;
    for (var dx = -2; dx <= 2; dx = dx + 1) {
        for (var dy = -2; dy <= 2; dy = dy + 1) {
            let offset = vec2<f32>(f32(dx), f32(dy)) * texelSize;
            shadow += textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy + offset, lightUVSpacePos.z);
        }
    }
    shadow = shadow / 25.0;
    return shadow;
}
