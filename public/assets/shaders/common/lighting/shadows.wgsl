// Shadow mapping utilities - common functions
// Level 3: Depends on core/constants

#include "common/core/constants"


// Kernel Poisson pre-computado (8 taps, distribución uniforme)
const poissonDisk: array<vec2<f32>, 8> = array<vec2<f32>, 8>(
    vec2<f32>(-0.9450, -0.3165),
    vec2<f32>(-0.6926,  0.5763),
    vec2<f32>(-0.2654, -0.8867),
    vec2<f32>( 0.1566,  0.4173),
    vec2<f32>(-0.1322,  0.9346),
    vec2<f32>( 0.5915, -0.5831),
    vec2<f32>( 0.8743,  0.2891),
    vec2<f32>( 0.3865, -0.1276)
);

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

    let texelSize = lightShadowStepDivResolution;
    let kernelRadius = texelSize * 1.5;

    // Rotar el kernel basado en la posición del TEXEL en el shadow map, no en world pos
    // Esto hace que la rotación sea ESTABLE — no cambia cuando se mueve la cámara,
    // solo cambia si el objeto se mueve en el shadow map
    let shadowTexelPos = floor(lightUVSpacePos.xy / texelSize);
    let angle = fract(sin(dot(shadowTexelPos, vec2<f32>(127.1, 311.7))) * 43758.5453) * 6.2832;
    let cosA = cos(angle);
    let sinA = sin(angle);

    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        // Rotar el tap Poisson por el ángulo estable
        let rotated = vec2<f32>(
            poissonDisk[i].x * cosA - poissonDisk[i].y * sinA,
            poissonDisk[i].x * sinA + poissonDisk[i].y * cosA
        );
        shadow += textureSampleCompareLevel(
            shadowMap, shadowSampler,
            lightUVSpacePos.xy + rotated * kernelRadius,
            lightUVSpacePos.z
        );
    }
    return shadow / 8.0;
}


fn getShadowFactorSimple(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
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

    return textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy, lightUVSpacePos.z);
}