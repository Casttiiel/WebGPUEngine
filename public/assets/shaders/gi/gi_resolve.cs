// ---------------------------------------------------------------------------
// GI resolve: probe irradiance for the G-buffer at reduced resolution (RealtimeGI.resolve).
// One thread per low-res texel, evaluated at the top-left full-res pixel of its block:
//   rgb = irradiance E for ambient_gi.fs: GI × intensity + baked probes / sky (× ambient boosts)
//         where the GI volumes don't cover the point
//   a   = specular scale for ambient_specular.fs (REALTIME_GI): GI irradiance / baked irradiance,
//         ≤ 1 — reflections captured without the local lighting darken where GI says so
// Sampling the probes is the expensive part of GI shading (8 probes × 4 fetches); doing it once
// per 2×2 block and once for both passes is what keeps 4K affordable. ambient_gi.fs upsamples
// it depth/normal-aware.
//
// With the final gather on (GI_FLAG_GATHER) the denoised per-pixel gather (gi_gather.cs →
// gi_gather_denoise.cs) refines it: E = near-field bounce of the short rays + this irradiance ×
// the share of rays that escaped (contact occlusion).
//
// Temporal filter: blended with last frame's result reprojected to this point (ping-pong
// history). The history is rejected where the distance to the camera disagrees (disocclusion),
// so it doesn't ghost. A per-texel history length (distance target .g) makes it a running mean
// up to the configured weight, so disoccluded texels converge in a few frames instead of
// fading in. It averages out the probe noise of interiors lit by small bright patches and the
// one-ray-per-texel gather noise.
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/probes"
#include "gi/common/gi_common"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<storage, read> probeSet: ProbeSet;
@group(0) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(0) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(0) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(0) @binding(7) var giSampler: sampler;
@group(0) @binding(8) var<storage, read> giVolumes: array<GIVolume>;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

struct ResolveTemporal {
    prevViewProj: mat4x4<f32>,
    prevCamera:   vec4<f32>,   // xyz = last frame's camera position, w = 1 when the history is valid
    info:         vec4<f32>,   // x = max history weight
}

@group(2) @binding(0) var outResolve: texture_storage_2d<rgba16float, write>;
@group(2) @binding(1) var outDistance: texture_storage_2d<rg32float, write>;  // distance, history length
@group(2) @binding(2) var histResolve: texture_2d<f32>;
@group(2) @binding(3) var histDistance: texture_2d<f32>;
@group(2) @binding(4) var<uniform> temporal: ResolveTemporal;
@group(2) @binding(5) var gatherIrradiance: texture_2d<f32>;

#include "gi/common/gi_sampling"

/** ambient.fs irradiance: baked probes, sky SH, hemisphere placeholder — × ambient boosts. */
fn bakedIrradiance(pos: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
    let probes = probeIrradiance(pos, N);
    var irradiance = probes.irradiance;
    if (probes.coverage < 1.0) {
        let hemi = N.y * 0.5 + 0.5;
        irradiance += mix(vec3<f32>(0.10, 0.07, 0.04), vec3<f32>(0.38, 0.50, 0.65), hemi)
                    * (1.0 - probes.coverage);
    }
    return irradiance * giParams.ambient.x * giParams.ambient.y;
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(outResolve);
    if (any(gid.xy >= size)) { return; }
    let fullSize = vec2<f32>(textureDimensions(gLinearDepth));
    let scale = fullSize / vec2<f32>(size);
    let uv = (floor(vec2<f32>(gid.xy) * scale) + 0.5) / fullSize;

    let g = decodeGBuffer(uv);
    if (g.zlinear > 0.999) {
        textureStore(outResolve, gid.xy, vec4<f32>(0.0, 0.0, 0.0, 1.0));
        textureStore(outDistance, gid.xy, vec4<f32>(-1.0, 0.0, 0.0, 0.0));
        return;
    }
    let N = normalize(g.normal);
    let gi = giSampleIrradiance(g.worldPos, N, normalize(g.viewDir));
    let coverage = gi.a;

    // Baked probes only where the GI volumes don't reach (and for the specular ratio).
    let baked = bakedIrradiance(g.worldPos, N);
    var irradiance = gi.rgb * giParams.tuning.z + baked * (1.0 - coverage);
    if ((giParams.frameInfo.w & GI_FLAG_GATHER) != 0u) {
        let gather = textureLoad(gatherIrradiance, gid.xy, 0);
        if (gather.a >= 0.0) { irradiance = gather.rgb + irradiance * gather.a; }
    }

    let lum = vec3<f32>(0.2126, 0.7152, 0.0722);
    let bakedLum = dot(baked, lum);
    let specScale = select(1.0, saturate(dot(irradiance, lum) / max(bakedLum, 1e-3)), coverage > 0.0);

    var result = vec4<f32>(irradiance, specScale);

    // ── Temporal filter ───────────────────────────────────────────────────────
    let maxLength = 1.0 / max(1.0 - temporal.info.x, 1e-3);
    var historyLength = 1.0;
    if (temporal.prevCamera.w > 0.5) {
        let clip = temporal.prevViewProj * vec4<f32>(g.worldPos, 1.0);
        if (clip.w > 1e-4) {
            let ndc = clip.xy / clip.w;
            let prevUV = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
            if (all(prevUV > vec2<f32>(0.0)) && all(prevUV < vec2<f32>(1.0))) {
                // Bilinear over the 4 history texels, each kept only where its distance to the
                // camera matches this point (a nearest tap shimmers at reduced resolution).
                let expected = distance(g.worldPos, temporal.prevCamera.xyz);
                let p = prevUV * vec2<f32>(size) - 0.5;
                let base = vec2<i32>(floor(p));
                let f = p - floor(p);
                let maxTexel = vec2<i32>(size) - 1;
                var history = vec4<f32>(0.0);
                var lengthSum = 0.0;
                var wsum = 0.0;
                for (var i = 0; i < 4; i++) {
                    let off = vec2<i32>(i & 1, i >> 1);
                    let texel = clamp(base + off, vec2<i32>(0), maxTexel);
                    let hist = textureLoad(histDistance, texel, 0).xy;
                    if (hist.x <= 0.0 || abs(hist.x - expected) >= expected * 0.05 + 0.05) { continue; }
                    let w = mix(1.0 - f.x, f.x, f32(off.x)) * mix(1.0 - f.y, f.y, f32(off.y));
                    history += textureLoad(histResolve, texel, 0) * w;
                    lengthSum += hist.y * w;
                    wsum += w;
                }
                if (wsum > 0.05) {
                    historyLength = min(lengthSum / wsum + 1.0, maxLength);
                    result = mix(result, history / wsum, 1.0 - 1.0 / historyLength);
                }
            }
        }
    }
    textureStore(outResolve, gid.xy, result);
    textureStore(outDistance, gid.xy, vec4<f32>(distance(g.worldPos, camera.cameraPosition.xyz), historyLength, 0.0, 0.0));
}
