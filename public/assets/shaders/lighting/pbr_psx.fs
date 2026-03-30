#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
#include "common/octahedral"
#include "common/gbuffer"

// PSX variant of pbr.fs: spot-light shadows are Bayer-dithered instead of PCF.
// All PBR shading is identical — only shadow_factor is quantized via the Bayer matrix.

struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>,
    intensity: f32,
    viewProjOffset: mat4x4<f32>,
    radius: f32,
    shadowStep: f32,
    shadowInverseResolution: f32,
    shadowStepDivResolution: f32,
    startFalloff: f32,
    padding: vec3<f32>,
    extraPadding: f32,
}

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

// Wide-kernel PCF for PSX dithering: 8× the normal radius so the gradient zone
// is wide enough in screen space to show a visible Bayer stipple pattern.
fn getShadowFactorSpotPSX(
    wPos: vec3<f32>,
    lightViewProjOffset: mat4x4<f32>,
    texelSize: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison,
) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    lightUVSpacePos.x =  lightUVSpacePos.x * 0.5 + 0.5;
    lightUVSpacePos.y = -lightUVSpacePos.y * 0.5 + 0.5;
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }
    let kernelRadius = texelSize * 8.0;  // Wider kernel → visible dithered zone
    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        let offset = poissonDisk[i] * kernelRadius;
        shadow += textureSampleCompareLevel(
            shadowMap, shadowSampler,
            lightUVSpacePos.xy + offset,
            lightUVSpacePos.z,
        );
    }
    return shadow / 8.0;
}

fn shade_psx(iPosition: vec2<f32>, fragPos: vec4<f32>, use_shadows: bool, fix_shadows: bool) -> vec4<f32> {
    let g = decodeGBuffer(iPosition);

    var shadow_factor = 1.0;
    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = abs(length(light_dir_full));
    let light_dir = light_dir_full / distance_to_light;

    if (use_shadows) {
        let pcf = getShadowFactorSpotPSX(g.worldPos, light.viewProjOffset, light.shadowStepDivResolution, gShadowMap, gShadowSampler);
        // Bayer threshold: convert wide-gradient PCF to stippled binary shadow
        let bayer = bayer4(vec2<u32>(fragPos.xy));
        shadow_factor = select(0.0, 1.0, pcf > bayer);
    }

    let worldPos = vec4<f32>(g.worldPos, 1.0);
    if (fix_shadows) {
        let almostScreenPos = light.viewProjOffset * worldPos;
        let screenPos = almostScreenPos.xyz / almostScreenPos.w;
        if (screenPos.x < -1.0 || screenPos.x > 1.0 || screenPos.y < -1.0 || screenPos.y > 1.0 || screenPos.z < 0.0 || screenPos.z > 1.0) {
            shadow_factor = 0.0;
        }
    }

    if (fix_shadows || use_shadows) {
        let almostScreenPos = light.viewProjOffset * worldPos;
        let screenPos = almostScreenPos.xyz / almostScreenPos.w;
        let projectorUv = screenPos.xy * 0.5 + 0.5;
        let projector = textureSampleLevel(projectorTexture, projectorSampler, projectorUv.xy, 0.0).r;
        shadow_factor *= projector;
    }

    let NdL = max(dot(g.normal, light_dir), 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    let h = normalize(light_dir + g.viewDir);

    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);

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
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, iPosition, 0.0).b;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * light.intensity * shadow_factor * (diffuse_contrib * hl + specular_contrib * NdL) * att * ms;
    return vec4<f32>(final_color, 1.0);
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var gShadowMap: texture_depth_2d;
@group(3) @binding(2) var gShadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>;
@group(3) @binding(4) var projectorSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

@fragment
fn PS_dir_lights_shadow(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = fragPos.xy / camera.screenSize;
    return shade_psx(pos, fragPos, true, true);
}
