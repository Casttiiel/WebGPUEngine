#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
#include "common/octahedral"
#include "common/gbuffer"

// PSX variant: point-light cube-shadow is Bayer-dithered instead of PCF.

struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>,
    intensity: f32,
    viewProjOffset: mat4x4<f32>,
    radius: f32,
    shadowNear: f32,
    shadowFar: f32,
    shadowStepDivResolution: f32,
    startFalloff: f32,
    padding: vec3<f32>,
    extraPadding: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var gPointShadowCube: texture_depth_cube;
@group(3) @binding(2) var gShadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>;
@group(3) @binding(4) var projectorSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

// Bayer 4×4 ordered-dither matrix.
fn bayer4(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

// Wide-kernel PCF for PSX point-light dithering.
// Uses 8× normal kernel radius so the shadow boundary gradient covers enough
// screen pixels for the Bayer stipple pattern to be clearly visible.
fn getShadowFactorCubePSX(
    wPos: vec3<f32>,
    lightPos: vec3<f32>,
    shadowNear: f32,
    shadowFar: f32,
    invResolution: f32,
    shadowCube: texture_depth_cube,
    shadowSampler: sampler_comparison,
) -> f32 {
    let dir  = wPos - lightPos;
    let dist = length(dir);

    let A = shadowFar / (shadowFar - shadowNear);
    let B = -(shadowFar * shadowNear) / (shadowFar - shadowNear);

    // 8× wider kernel than the normal shadow for a visible dithered zone
    let kernelRadius = (0.02 * dist + 0.001) * 8.0;

    let dirN    = normalize(dir);
    let worldUp = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(dirN.y) < 0.99);
    let right   = normalize(cross(dirN, worldUp));
    let up      = normalize(cross(right, dirN));

    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        let tapDir = dir + right * poissonDisk[i].x * kernelRadius
                        + up    * poissonDisk[i].y * kernelRadius;

        let tapAbs  = abs(tapDir);
        let tapXDom = tapAbs.x >= tapAbs.y && tapAbs.x >= tapAbs.z;
        let tapSampleDir = select(
            vec3<f32>(-tapDir.x,  tapDir.y,  tapDir.z),
            vec3<f32>( tapDir.x,  tapDir.y, -tapDir.z),
            tapXDom
        );

        let tapFaceZ  = max(max(tapAbs.x, tapAbs.y), tapAbs.z);
        let tapFaceZs = max(tapFaceZ, 0.0001);
        let texelBias = 2.0 * abs(B) * invResolution / tapFaceZs;
        let tap_depth = clamp(A + B / tapFaceZs - texelBias * 1.5, 0.0, 1.0);
        let tap_in_range = tapFaceZ >= shadowNear && tapFaceZ <= shadowFar;
        let tap_cmp = select(0.0, tap_depth, tap_in_range);

        shadow += textureSampleCompare(shadowCube, shadowSampler, tapSampleDir, tap_cmp);
    }
    return shadow / 8.0;
}

@fragment
fn PS_point_lights_shadow(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = fragPos.xy / camera.screenSize;
    let g = decodeGBuffer(pos);

    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = length(light_dir_full);
    let light_dir = light_dir_full / distance_to_light;

    let NdL_raw = dot(g.normal, light_dir);
    let normalBiasScale = clamp(1.0 - NdL_raw, 0.0, 1.0);
    let biasedWorldPos = g.worldPos + g.normal * 0.05 * normalBiasScale;

    // Wide-kernel PCF → Bayer threshold
    let pcf   = getShadowFactorCubePSX(
        biasedWorldPos, light.position.xyz,
        light.shadowNear, light.shadowFar,
        light.shadowStepDivResolution,
        gPointShadowCube, gShadowSampler,
    );
    let bayer = bayer4(vec2<u32>(fragPos.xy));
    let shadow_factor = select(0.0, 1.0, pcf > bayer);

    let NdL = max(NdL_raw, 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);

    let h   = normalize(light_dir + g.viewDir);
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a   = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);

    let d  = distance_to_light;
    let r0 = light.startFalloff;
    let r1 = light.radius;
    var att = 1.0;
    if (d > r0) {
        let t = saturate((d - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let F  = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);

    let diffuse_contrib  = kD * cDiff;
    let specular_contrib = cSpec;

    let hl = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, pos, 0.0).r;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * light.intensity * shadow_factor * (diffuse_contrib * hl + specular_contrib * NdL) * att * ms;
    return vec4<f32>(final_color, 1.0);
}
