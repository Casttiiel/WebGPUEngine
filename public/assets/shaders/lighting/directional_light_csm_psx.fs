#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/lighting/csm"
#include "common/lighting/shadows"

// PSX variant: replaces smooth PCF shadows with Bayer-dithered binary shadows.
// All PBR lighting is identical to directional_light_csm.fs — only the shadow
// sampling path differs.

const DEBUG_CASCADE_COLORS: bool = false;

alias LightUniformsCSM = DirectionalLightCSMUniforms;

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> light: LightUniformsCSM;
@group(2) @binding(1) var gShadowMap0: texture_depth_2d;
@group(2) @binding(2) var gShadowMap1: texture_depth_2d;
@group(2) @binding(3) var gShadowMap2: texture_depth_2d;
@group(2) @binding(4) var gShadowSampler: sampler_comparison;
@group(2) @binding(5) var contactShadowMap:     texture_2d<f32>;
@group(2) @binding(6) var contactShadowSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);
    if (cascadeIndex == 0) { return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false); }
    if (cascadeIndex == 1) { return getShadowFactor(worldPos, light.viewProjOffset1, light.shadowParams.y, gShadowMap1, gShadowSampler, false); }
    return getShadowFactor(worldPos, light.viewProjOffset2, light.shadowParams.z, gShadowMap2, gShadowSampler, false);
}

fn getShadowFactorForCascadeIndex(worldPos: vec3<f32>, idx: i32) -> f32 {
    if (idx == 0) { return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false); }
    if (idx == 1) { return getShadowFactor(worldPos, light.viewProjOffset1, light.shadowParams.y, gShadowMap1, gShadowSampler, false); }
    return getShadowFactor(worldPos, light.viewProjOffset2, light.shadowParams.z, gShadowMap2, gShadowSampler, false);
}

fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(light.cascadeSplits.w);

    if (cascadeCount == 1) {
        return getShadowFactor(worldPos, light.viewProjOffset0, light.shadowParams.x, gShadowMap0, gShadowSampler, false);
    }

    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);

    var splitDist: f32;
    if      (cascadeIndex == 0) { splitDist = light.cascadeSplits.x; }
    else if (cascadeIndex == 1) { splitDist = light.cascadeSplits.y; }
    else                        { splitDist = light.cascadeSplits.z; }

    let blendZone   = max(splitDist * 0.1, 1.0);
    let blendStart  = splitDist - blendZone;
    let blendFactor = saturate((viewSpaceDepth - blendStart) / blendZone);

    let shadow1 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex);
    if (blendFactor < 0.01) { return shadow1; }

    var shadow2: f32;
    if (cascadeIndex >= cascadeCount - 1) {
        shadow2 = 1.0;
    } else {
        shadow2 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex + 1);
    }

    return mix(shadow1, shadow2, smoothstep(0.0, 1.0, blendFactor));
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

@fragment
fn fs(@location(0) uv: vec2<f32>, @builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);

    if (g.zlinear >= 1.0) {
        discard;
    }

    let viewSpaceDepth = g.zlinear * camera.cameraFar;
    let cascadeIndex   = selectCascadeCSM(viewSpaceDepth, light.cascadeSplits);

    var cascadeColor = vec3<f32>(1.0);
    if (DEBUG_CASCADE_COLORS) {
        cascadeColor = getCascadeDebugColorCSM(cascadeIndex);
    }

    var shadow_factor = 1.0;
    let light_dir = normalize(light.position);

    if (light.hasShadows > 0.5) {
        // Get the smooth PCF value then threshold it with the Bayer matrix.
        // This gives hard-edged, stippled PSX-style shadow boundaries.
        let pcf   = getShadowFactorCSMBlended(g.worldPos, viewSpaceDepth);
        let bayer = bayer4(vec2<u32>(fragPos.xy));
        shadow_factor = select(0.0, 1.0, pcf > bayer);
    }

    let NdL = max(dot(g.normal, light_dir), 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    let h = normalize(light_dir + g.viewDir);

    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a   = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);

    let F  = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);

    let diffuse_contrib  = kD * cDiff;
    let specular_contrib = cSpec;

    let hl  = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, uv, 0.0).r;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * (diffuse_contrib * hl + specular_contrib * NdL) * light.intensity * shadow_factor * ms;

    let contactFactor = textureSampleLevel(contactShadowMap, contactShadowSampler, uv, 0.0).r;
    return vec4<f32>(final_color * cascadeColor * contactFactor, 1.0);
}
