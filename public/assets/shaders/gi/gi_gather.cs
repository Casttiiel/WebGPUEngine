// ---------------------------------------------------------------------------
// GI final gather (GIFinalGather.ts): one cosine-distributed ray per texel of the GI resolve
// (reduced resolution, evaluated at the top-left full-res pixel of its block, like
// gi_resolve.cs). Short rays (cache.w metres) supply what the probes can't resolve: contact
// occlusion in corners and under objects, and bounce from surfaces close by. Nothing is shaded
// here; radiance comes from caches:
//   front-face hit  → its radiance-cache cell (inserted / touched, so the cache follows what the
//                     camera sees); a cell never shaded yet → albedo · probe irradiance at the hit
//   back-face hit   → 0 (the ray left from inside geometry: occluded)
//   no hit in range → far field, added by gi_resolve.cs: the probe irradiance at the pixel
//                     weighted by the share of rays that escaped (sampling the probes per ray
//                     cost more than the trace; at the pixel they are already sampled once)
// Output: rgb = near-field irradiance estimate (π · L on hits, 0 on escapes; cosine pdf),
//         a = 1 when the ray escaped. Sky texels: (0, 0, 0, -1).
// gi_gather_denoise.cs filters it, gi_resolve.cs combines and accumulates it over time.
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"
#include "common/probes"
#include "gi/common/gi_common"
#include "gi/common/bvh"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<storage, read> probeSet: ProbeSet;
@group(0) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(0) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(0) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(0) @binding(7) var giSampler: sampler;
@group(0) @binding(8) var<storage, read> giVolumes: array<GIVolume>;
@group(0) @binding(10) var<storage, read_write> giCacheKeys: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> giCacheCells: array<GICacheCell>;

@group(2) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(2) @binding(1) var gNormals:       texture_2d<f32>;
@group(2) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(2) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var outGather: texture_storage_2d<rgba16float, write>;

#include "gi/common/gi_sampling"
#include "gi/common/gi_cache"

/** Ray origin offset along the normal: the BVH is coarser than the rasterised surface. */
const ORIGIN_BIAS: f32 = 0.03;
/** Estimates above this luminance are scaled down (fireflies from small bright cells). */
const MAX_LUMINANCE: f32 = 24.0;

/** Orthonormal basis around n (Duff et al. 2017). */
fn basis(n: vec3<f32>) -> mat3x3<f32> {
    let s = select(-1.0, 1.0, n.z >= 0.0);
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    return mat3x3<f32>(
        vec3<f32>(1.0 + s * n.x * n.x * a, s * b, -s * n.x),
        vec3<f32>(b, s + n.y * n.y * a, -n.y),
        n,
    );
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(outGather);
    if (any(gid.xy >= size)) { return; }
    let fullSize = vec2<f32>(textureDimensions(gLinearDepth));
    let scale = fullSize / vec2<f32>(size);
    let uv = (floor(vec2<f32>(gid.xy) * scale) + 0.5) / fullSize;

    let g = decodeGBuffer(uv);
    if (g.zlinear > 0.999) {
        textureStore(outGather, gid.xy, vec4<f32>(0.0, 0.0, 0.0, -1.0));
        return;
    }
    let N = normalize(g.normal);

    // Interleaved gradient noise per texel, advanced by golden-ratio steps per frame.
    let frame = f32(giParams.frameInfo.x % 1024u);
    let px = vec2<f32>(gid.xy);
    let ign = fract(52.9829189 * fract(dot(px, vec2<f32>(0.06711056, 0.00583715))));
    var rng = giHash(gid.x * 1973u + gid.y * 9277u);
    let u1 = fract(ign + frame * 0.61803399);
    let u2 = fract(giRand(&rng) + frame * 0.75487767);
    let r = sqrt(u1);
    let phi = 2.0 * GI_PI * u2;
    let dir = normalize(basis(N) * vec3<f32>(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1))));

    let origin = g.worldPos + N * (ORIGIN_BIAS + 0.002 * distance(g.worldPos, camera.cameraPosition.xyz));
    let range = giParams.cache.w;
    let hit = giTrace(origin, dir, range, false);

    var E = vec3<f32>(0.0);
    var escaped = 0.0;
    if (hit.tri == GI_MISS) {
        escaped = 1.0;
    } else {
        let s = giHitSurface(origin, dir, hit);
        if (s.frontFace) {
            var L = vec3<f32>(-1.0);
            let cell = giCacheFind(s.pos, s.normal, true);
            if (cell != GI_MISS) {
                giCacheTouch(cell, s.pos, s.normal, s.albedo, s.emissive);
                let cached = giCacheCells[cell].radiance;
                if (cached.w > 0.0) { L = cached.rgb; }
            }
            if (L.x < 0.0) {
                let Eh = giSampleIrradiance(s.pos, s.normal, -dir).rgb * giParams.tuning.z;
                L = s.albedo * (Eh * GI_INV_PI + s.emissive);
            }
            E = L * GI_PI;
        }
    }

    let lum = dot(E, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (lum > MAX_LUMINANCE) { E *= MAX_LUMINANCE / lum; }
    textureStore(outGather, gid.xy, vec4<f32>(E, escaped));
}
