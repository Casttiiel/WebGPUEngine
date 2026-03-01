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

    // Sin snap — Poisson distribuye los taps de forma que el noise
    // es isotrópico y no produce banding estructural
    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        let offset = poissonDisk[i] * kernelRadius;
        shadow += textureSampleCompareLevel(
            shadowMap, shadowSampler,
            lightUVSpacePos.xy + offset,
            lightUVSpacePos.z
        );
    }
    return shadow / 8.0;
}


// PCF cube shadow for omnidirectional (point) lights.
//
// KEY: the depth stored in each cubemap face was written by a perspective camera
// whose view-space Z equals the *dominant axis component* of dir, not length(dir).
// Using length(dir) for the reference is wrong and causes everything to appear in shadow,
// especially on the faces pointing up/down where horizontal spread makes dist >> faceZ.
fn getShadowFactorCube(
    wPos: vec3<f32>,
    lightPos: vec3<f32>,
    shadowNear: f32,
    shadowFar: f32,
    shadowCube: texture_depth_cube,
    shadowSampler: sampler_comparison,
) -> f32 {
    let dir  = wPos - lightPos;
    let dist = length(dir);

    // The face camera stores depth using its view-space Z = the dominant axis component.
    let absDir = abs(dir);
    let faceZ  = max(absDir.x, max(absDir.y, absDir.z));

    // gl-matrix lookAt builds a right-vector that is the mirror of what WebGPU/Vulkan
    // cubemap sampling expects. The mismatch is in the sc (horizontal UV) component,
    // which differs per major axis:
    //   ±X faces: sc_vulkan = -dir.z, sc_rendered = +dir.z  → negate dir.z to fix
    //   ±Y faces: sc_vulkan = +dir.x, sc_rendered = -dir.x  → negate dir.x to fix
    //   ±Z faces: sc_vulkan = +dir.x, sc_rendered = -dir.x  → negate dir.x to fix
    // Both branches converge before textureSampleCompare so uniform control flow is preserved.
    let xDominant = absDir.x >= absDir.y && absDir.x >= absDir.z;
    let sampleDir = select(
        vec3<f32>(-dir.x, dir.y,  dir.z),   // ±Y / ±Z dominant: negate X
        vec3<f32>( dir.x, dir.y, -dir.z),   // ±X dominant:      negate Z
        xDominant
    );

    // ZO perspective depth formula matching perspectiveZO projection
    let A = shadowFar / (shadowFar - shadowNear);
    let B = -(shadowFar * shadowNear) / (shadowFar - shadowNear);
    let ref_depth = clamp(A + B / max(faceZ, 0.0001), 0.0, 1.0) - 0.002;

    // Use select (not early return) to keep uniform control flow for textureSampleCompare.
    // compare:'less' → returns 1.0 (lit) when ref < stored. 0.0 is always < stored → lit.
    let in_range = dist >= shadowNear && dist <= shadowFar;
    let cmp_depth = select(0.0, ref_depth, in_range);

    return textureSampleCompare(shadowCube, shadowSampler, sampleDir, cmp_depth);
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