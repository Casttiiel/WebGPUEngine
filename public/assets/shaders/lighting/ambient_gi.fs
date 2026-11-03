// Ambient diffuse with realtime GI (RealtimeGI.renderDiffuse) — same contract as ambient.fs
// (clears accLight to ambient + self-illumination). The irradiance comes from the GI resolve
// (gi/gi_resolve.cs, reduced resolution), upsampled here with depth/normal-aware weights so it
// doesn't bleed across edges. In compare mode the left side uses the baked probes exactly as
// ambient.fs does.
// GI_DIRECT (RealtimeGI.renderDiffuseDirect, the water G-buffer): no resolve — the probe
// volumes are sampled per pixel (group 3, GISharedResources), baked probes fill the rest.

#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/probes"
#include "gi/common/gi_common"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var gAO:               texture_2d<f32>;
@group(2) @binding(1) var samplerAO:         sampler;
#ifndef GI_DIRECT
@group(2) @binding(2) var<uniform> giParams: GIParams;
#endif
@group(2) @binding(3) var brdfLUT:           texture_2d<f32>;
@group(2) @binding(4) var<storage, read> probeSet: ProbeSet;
@group(2) @binding(5) var giResolve:         texture_2d<f32>;

#ifdef GI_DIRECT
@group(3) @binding(0) var<uniform> giParams: GIParams;
@group(3) @binding(1) var<storage, read> giProbeState: array<vec4<f32>>;
@group(3) @binding(2) var<storage, read> giVolumes: array<GIVolume>;
@group(3) @binding(3) var giIrradianceAtlas: texture_2d<f32>;
@group(3) @binding(4) var giVisibilityAtlas: texture_2d<f32>;
@group(3) @binding(5) var giSampler: sampler;
#include "gi/common/gi_sampling"
#endif

/** ambient.fs irradiance: baked probes, sky SH, hemisphere placeholder — × ambient boosts. */
fn bakedIrradiance(g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let probes = probeIrradiance(g.worldPos, N);
    var irradiance = probes.irradiance;
    if (probes.coverage < 1.0) {
        let hemi = N.y * 0.5 + 0.5;
        irradiance += mix(vec3<f32>(0.10, 0.07, 0.04), vec3<f32>(0.38, 0.50, 0.65), hemi)
                    * (1.0 - probes.coverage);
    }
    return irradiance * giParams.ambient.x * giParams.ambient.y;
}

/**
 * Joint bilateral upsample of the GI resolve: the 4 low-res texels around the pixel, bilinear
 * weights × depth and normal similarity of the full-res pixel each was evaluated at.
 */
fn upsampleGI(fragCoord: vec2<f32>, g: GBuffer) -> vec3<f32> {
    let lowSize = vec2<f32>(textureDimensions(giResolve));
    let fullSize = vec2<f32>(textureDimensions(gLinearDepth));
    let scale = fullSize / lowSize;
    let p = fragCoord / scale - 0.5;
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    let N = normalize(g.normal);
    let maxTexel = vec2<i32>(lowSize) - 1;

    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 4; i++) {
        let off = vec2<i32>(i & 1, i >> 1);
        let t = clamp(base + off, vec2<i32>(0), maxTexel);
        let src = vec2<i32>(floor(vec2<f32>(t) * scale));
        let z = textureLoad(gLinearDepth, src, 0).x;
        let n = octahedral01ToNormal(textureLoad(gNormals, src, 0).xy);
        let bil = mix(1.0 - f.x, f.x, f32(off.x)) * mix(1.0 - f.y, f.y, f32(off.y));
        let wz = 1.0 / (1.0 + abs(z - g.zlinear) / max(g.zlinear, 1e-4) * 64.0);
        let wn = pow(saturate(dot(n, N)), 8.0);
        let w = max(bil * wz * wn, 1e-5 * bil);
        sum += textureLoad(giResolve, t, 0).rgb * w;
        wsum += w;
    }
    return sum / max(wsum, 1e-6);
}

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let ao = textureSample(gAO, samplerAO, uv).b;
    if (g.zlinear > 0.999) { discard; }

    let N = normalize(g.normal);
    let compare = (giParams.frameInfo.w & GI_FLAG_COMPARE) != 0u;
    let split = giParams.tuning.w;

    var irradiance: vec3<f32>;
    if (compare && uv.x < split) {
        irradiance = bakedIrradiance(g);
    } else {
#ifdef GI_DIRECT
        let gi = giSampleIrradiance(g.worldPos, N, normalize(g.viewDir));
        irradiance = gi.rgb * giParams.tuning.z + bakedIrradiance(g) * (1.0 - gi.a);
#else
        irradiance = upsampleGI(fragCoord.xy, g);
#endif
    }

    // kD exactly as ambient.fs (LUT directional albedo + Kulla-Conty multiple scattering).
    let NdV = clamp(dot(N, normalize(g.viewDir)), 0.001, 1.0);
    let brdf = textureSampleLevel(brdfLUT, samplerAO, vec2<f32>(NdV, 1.0 - clamp(g.roughness, 0.0, 1.0)), 0.0).rg;
    let E    = g.specularColor * brdf.x + brdf.y;
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = g.specularColor + (1.0 - g.specularColor) / 21.0;
    let Fms  = E * Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let kD   = (1.0 - E - Fms) * (1.0 - g.metallic);

    var color = kD * Diffuse(g.albedo) * irradiance * ao + g.selfIllum;
    if (compare && abs(fragCoord.x - split * camera.screenSize.x) < 1.0) {
        color = vec3<f32>(2.0);
    }
    return vec4<f32>(color, 1.0);
}
