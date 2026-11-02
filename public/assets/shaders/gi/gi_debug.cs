// ---------------------------------------------------------------------------
// GI debug views (RealtimeGI, giParams.frameInfo.z), one thread per pixel, blitted over
// accLight at the end of the frame:
//   1 irradiance — GI irradiance on a white Lambert surface (E/π), no textures/lights
//   2 bvh albedo — primary ray through the BVH: baked albedo, lit by a fixed sun term
//   3 bvh normal — primary ray through the BVH: world normal (back faces red)
//   4 volumes    — first volume covering each G-buffer pixel (local → level/cascades), checker = probe cells
//   5 coverage   — GI coverage (green) vs baked-probe fallback (red)
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"
#include "gi/common/gi_common"
#include "gi/common/bvh"

@group(0) @binding(0) var<uniform> giParams: GIParams;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(0) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(0) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(0) @binding(7) var giSampler: sampler;
@group(0) @binding(8) var<storage, read> giVolumes: array<GIVolume>;

@group(2) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(2) @binding(1) var gNormals:       texture_2d<f32>;
@group(2) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(2) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var outDebug: texture_storage_2d<rgba16float, write>;

#include "gi/common/gi_sampling"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = vec2<u32>(textureDimensions(outDebug));
    if (any(gid.xy >= size)) { return; }
    let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
    let mode = giParams.frameInfo.z;
    var color = vec3<f32>(0.0);

    if (mode == 2u || mode == 3u) {
        let origin = camera.cameraPosition.xyz;
        let farPoint = getWorldCoords(uv, 1.0, camera);
        let dir = normalize(farPoint - origin);
        let hit = giTrace(origin, dir, 1.0e4, false);
        if (hit.tri == GI_MISS) {
            color = vec3<f32>(0.05, 0.07, 0.12);
        } else {
            let s = giHitSurface(origin, dir, hit);
            if (mode == 2u) {
                let sun = max(dot(s.normal, normalize(vec3<f32>(0.4, 1.0, 0.3))), 0.0);
                color = s.albedo * (0.25 + 0.75 * sun) + s.albedo * s.emissive;
            } else {
                color = select(vec3<f32>(1.0, 0.0, 0.0), s.normal * 0.5 + 0.5, s.frontFace);
            }
        }
    } else {
        let g = decodeGBuffer(uv);
        if (g.zlinear > 0.999) {
            color = vec3<f32>(0.05, 0.07, 0.12);
        } else {
            let N = normalize(g.normal);
            let gi = giSampleIrradiance(g.worldPos, N, normalize(g.viewDir));
            if (mode == 1u) {
                color = gi.rgb * giParams.tuning.z * GI_INV_PI;
            } else if (mode == 5u) {
                color = mix(vec3<f32>(1.0, 0.1, 0.05), vec3<f32>(0.1, 1.0, 0.2), gi.a);
            } else {
                var cascadeColors = array<vec3<f32>, 4>(
                    vec3<f32>(1.0, 0.25, 0.2), vec3<f32>(0.25, 1.0, 0.3),
                    vec3<f32>(0.3, 0.45, 1.0), vec3<f32>(1.0, 0.9, 0.2),
                );
                color = vec3<f32>(0.1);
                for (var c = 0u; c < giParams.gridInfo.y; c++) {
                    let vol = giVolumes[c];
                    let local = g.worldPos / vol.spacing.x - vec3<f32>(vol.origin.xyz);
                    if (all(local > vec3<f32>(0.0)) && all(local < vec3<f32>(vol.dims.xyz) - 1.0)) {
                        // Probe cell checkerboard so the spacing is visible.
                        let cell = vec3<i32>(floor(local));
                        let checker = f32((cell.x + cell.y + cell.z) & 1);
                        // Local volumes magenta; level/cascades by cascade order.
                        let base = select(cascadeColors[min(c, 3u)], vec3<f32>(1.0, 0.3, 1.0), vol.spacing.z < 0.5);
                        color = base * (0.55 + 0.45 * checker);
                        break;
                    }
                }
            }
        }
    }
    textureStore(outDebug, gid.xy, vec4<f32>(color, 1.0));
}
