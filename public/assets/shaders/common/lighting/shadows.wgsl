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
    invResolution: f32,   // 1.0 / shadowResolution — for texel-accurate bias
    shadowCube: texture_depth_cube,
    shadowSampler: sampler_comparison,
) -> f32 {
    let dir  = wPos - lightPos;
    let dist = length(dir);

    // Perspective depth constants (ZO — zero-to-one, matching perspectiveZO)
    let A = shadowFar / (shadowFar - shadowNear);
    let B = -(shadowFar * shadowNear) / (shadowFar - shadowNear); // B < 0

    // Problem 1 fix — texel-accurate bias.
    // 1 texel in world space at a face = 2*faceZ / shadowResolution (FOV 90°).
    // Converting to NDC: dDepth/dfaceZ = |B|/faceZ², so
    //   texelBias = (2*faceZ/res) * |B|/faceZ² = 2*|B| / (res*faceZ)
    // We apply it per-tap below where each tap has its own faceZ.

    // Problem 3 fix — smooth kernel with a guaranteed minimum so it never
    // collapses near the light or explodes far away.
    let kernelRadius = 0.02 * dist + 0.001;

    // Tangent frame built on the ORIGINAL dir (Problem 2 fix — see tap loop).
    let dirN    = normalize(dir);
    let worldUp = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(dirN.y) < 0.99);
    let right   = normalize(cross(dirN, worldUp));
    let up      = normalize(cross(right, dirN));

    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        // Offset applied in original (uncorrected) direction space.
        let tapDir = dir + right * poissonDisk[i].x * kernelRadius
                        + up    * poissonDisk[i].y * kernelRadius;

        // Problem 2 fix — apply the gl-matrix/WebGPU cubemap correction per tap.
        // Every tap may land on a different face, so each needs its own correction:
        //   ±X dominant: negate Z   |   ±Y / ±Z dominant: negate X
        let tapAbs  = abs(tapDir);
        let tapXDom = tapAbs.x >= tapAbs.y && tapAbs.x >= tapAbs.z;
        let tapSampleDir = select(
            vec3<f32>(-tapDir.x,  tapDir.y,  tapDir.z),
            vec3<f32>( tapDir.x,  tapDir.y, -tapDir.z),
            tapXDom
        );

        // Depth and bias computed for this tap's face.
        let tapFaceZ    = max(max(tapAbs.x, tapAbs.y), tapAbs.z);
        let tapFaceZs   = max(tapFaceZ, 0.0001);
        let texelBias   = 2.0 * abs(B) * invResolution / tapFaceZs; // ~1.5 texels
        let tap_depth   = clamp(A + B / tapFaceZs - texelBias * 1.5, 0.0, 1.0);
        let tap_in_range = tapFaceZ >= shadowNear && tapFaceZ <= shadowFar;
        let tap_cmp     = select(0.0, tap_depth, tap_in_range);

        shadow += textureSampleCompare(shadowCube, shadowSampler, tapSampleDir, tap_cmp);
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