#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"

// Keep in sync with TiledLightManager.MAX_LIGHTS_PER_TILE
const MAX_LIGHTS_PER_TILE: u32 = 64u;
const TILE_SIZE:            u32 = 16u;

struct PointLightEntry {
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = worldPos, w = outerRadius
    falloff:        vec4<f32>,  // x = startFalloff, yzw = pad
}

struct SpotLightEntry {
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = worldPos, w = outerRadius
    falloff:        vec4<f32>,  // x = startFalloff, yzw = pad
    dirCosAngle:    vec4<f32>,  // xyz = forward dir, w = cos(outerHalfAngle)
}

struct TiledCullingParams {
    pointCount: u32,
    spotCount:  u32,
    numTilesX:  u32,
    numTilesY:  u32,
}

// group(0): Camera
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1): GBuffer + AO (GBufferWithAO layout)
@group(1) @binding(0) var gAlbedo:             texture_2d<f32>;
@group(1) @binding(1) var gNormals:            texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:        texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer:      sampler;
@group(1) @binding(4) var gAOMicroShadow:      texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

// group(2): Tiled light data
@group(2) @binding(0) var<uniform>           params:          TiledCullingParams;
@group(2) @binding(1) var<storage, read>     pointLights:     array<PointLightEntry>;
@group(2) @binding(2) var<storage, read>     spotLights:      array<SpotLightEntry>;
@group(2) @binding(3) var<storage, read>     tileLightCounts: array<vec2<u32>>;
@group(2) @binding(4) var<storage, read>     tilePointLists:  array<u32>;
@group(2) @binding(5) var<storage, read>     tileSpotLists:   array<u32>;

fn shadePoint(g: GBuffer, ao: f32, light: PointLightEntry) -> vec3<f32> {
    let toLight = light.posRadius.xyz - g.worldPos;
    let dist    = length(toLight);
    let r1      = light.posRadius.w;
    if (dist >= r1) { return vec3<f32>(0.0); }

    let L  = toLight / dist;
    let r0 = light.falloff.x;
    var att = 1.0;
    if (dist > r0) {
        let t = saturate((dist - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let NdL = max(dot(g.normal, L), 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    let h   = normalize(L + g.viewDir);
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(L, g.viewDir));
    let a   = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, L, a, NdL, NdV, NdH, VdH, LdV);
    let F     = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kD    = (vec3<f32>(1.0) - F) * (1.0 - g.metallic);

    let hl  = halfLambert(NdL);
    let ms  = microShadow(ao, NdL);
    let col = light.colorIntensity.rgb * light.colorIntensity.w;
    return col * (kD * cDiff * hl + cSpec * NdL) * att * ms;
}

fn shadeSpot(g: GBuffer, ao: f32, light: SpotLightEntry) -> vec3<f32> {
    let toLight = light.posRadius.xyz - g.worldPos;
    let dist    = length(toLight);
    let r1      = light.posRadius.w;
    if (dist >= r1) { return vec3<f32>(0.0); }

    let L = toLight / dist;

    // Cone test: dot(-L, spotForward) = cos(angle from spot axis to surface)
    let cosAngle = dot(-L, light.dirCosAngle.xyz);
    let cosHalf  = light.dirCosAngle.w;
    if (cosAngle < cosHalf) { return vec3<f32>(0.0); }

    // Smooth cone edge
    let coneFalloff = saturate((cosAngle - cosHalf) / max(1.0 - cosHalf, 0.001));
    let coneAtt     = coneFalloff * coneFalloff;

    let r0 = light.falloff.x;
    var att = 1.0;
    if (dist > r0) {
        let t = saturate((dist - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let NdL = max(dot(g.normal, L), 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);
    let h   = normalize(L + g.viewDir);
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(L, g.viewDir));
    let a   = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, L, a, NdL, NdV, NdH, VdH, LdV);
    let F     = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kD    = (vec3<f32>(1.0) - F) * (1.0 - g.metallic);

    let hl  = halfLambert(NdL);
    let ms  = microShadow(ao, NdL);
    let col = light.colorIntensity.rgb * light.colorIntensity.w;
    return col * (kD * cDiff * hl + cSpec * NdL) * att * coneAtt * ms;
}

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / camera.screenSize;

    // Sky early-out: additive 0 contribution preserves existing sky colour
    let zlin = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    if (zlin >= 0.9999) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

    let g  = decodeGBuffer(uv);
    let ao = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, uv, 0.0).b;

    let tileX   = u32(fragCoord.x) / TILE_SIZE;
    let tileY   = u32(fragCoord.y) / TILE_SIZE;
    let tileIdx = tileY * params.numTilesX + tileX;

    var accColor = vec3<f32>(0.0);

    let pCount = tileLightCounts[tileIdx].x;
    for (var i = 0u; i < pCount; i++) {
        let li = tilePointLists[tileIdx * MAX_LIGHTS_PER_TILE + i];
        accColor += shadePoint(g, ao, pointLights[li]);
    }

    let sCount = tileLightCounts[tileIdx].y;
    for (var i = 0u; i < sCount; i++) {
        let li = tileSpotLists[tileIdx * MAX_LIGHTS_PER_TILE + i];
        accColor += shadeSpot(g, ao, spotLights[li]);
    }

    return vec4<f32>(accColor, 1.0);
}
