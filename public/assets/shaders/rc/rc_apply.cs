#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// RCParams — same layout as rc_trace.cs / rc_merge.cs
// ---------------------------------------------------------------------------
struct RCParams {
    cascadeIndex:  f32,
    cascadeCount:  f32,
    baseRange:     f32,
    intervalStart: f32,
    intervalEnd:   f32,
    raysPerProbe:  f32,
    maxSteps:      f32,
    temporalBlend: f32,
    cascadeRes:    vec2<f32>,  // resolution of cascade 0 (the finest merged result)
    screenSize:    vec2<f32>,  // full-res screen dimensions
}

// group(0) — CameraUniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1) — GBuffer (compute visibility)
@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// group(2) — apply inputs
@group(2) @binding(0) var<uniform> rc:     RCParams;
@group(2) @binding(1) var cascade0:        texture_2d<f32>; // merged cascade 0 (W/4 irradiance)
@group(2) @binding(2) var samplerRC:       sampler;         // bilinear, clamp-to-edge

// group(3) — write-only GI result (full-res, rgba16float)
// The fragment composite pass will additively blend this onto rtAccLight.
@group(3) @binding(0) var giResult: texture_storage_2d<rgba16float, write>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEPTH_SIGMA:  f32 = 10.0;
const NORMAL_SIGMA: f32 = 4.0;
const DEPTH_THOLD:  f32 = 0.0001;

// ---------------------------------------------------------------------------
// Main — 3×3 bilateral upsample from cascade0 (W/4) to full-res,
//        followed by Lambertian PBR weighting and GI contribution write.
// ---------------------------------------------------------------------------
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p          = vec2<i32>(i32(gid.x), i32(gid.y));
    let screen_sz  = vec2<i32>(i32(rc.screenSize.x), i32(rc.screenSize.y));
    if (p.x >= screen_sz.x || p.y >= screen_sz.y) { return; }

    let p_depth = textureLoad(gLinearDepth, p, 0).r;
    if (p_depth <= DEPTH_THOLD) {
        // Sky pixel — write zero so the composite pass adds nothing
        textureStore(giResult, p, vec4<f32>(0.0));
        return;
    }

    let p_normals  = textureLoad(gNormals, p, 0);
    let p_normal   = decodeOctahedral(p_normals.xy);
    let roughness  = p_normals.b;
    let p_albedo_v = textureLoad(gAlbedo, p, 0);
    let metallic   = p_albedo_v.a;
    let albedo_rgb = p_albedo_v.rgb;

    // 3×3 bilateral upsample — weight by depth & normal similarity
    var weighted_sum  = vec3<f32>(0.0);
    var weight_total  = 0.0;

    let inv_screen = 1.0 / rc.screenSize;

    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let sample_uv = (vec2<f32>(p) + 0.5 + vec2<f32>(f32(dx), f32(dy))) * inv_screen;

            // GBuffer samples for bilateral weight (at the full-res neighbour)
            let smp_depth  = textureSampleLevel(gLinearDepth, samplerGBuffer, sample_uv, 0.0).r;
            let smp_normal = decodeOctahedral(
                textureSampleLevel(gNormals, samplerGBuffer, sample_uv, 0.0).xy
            );

            // Cascade-0 sample (bilinear — cascade0 is at W/4 so textureSampleLevel gives correct UV)
            let smp_rc = textureSampleLevel(cascade0, samplerRC, sample_uv, 0.0);

            // Bilateral weights
            let w_depth  = exp(-abs(p_depth - smp_depth) * DEPTH_SIGMA);
            let w_normal = exp(-(1.0 - max(dot(p_normal, smp_normal), 0.0)) * NORMAL_SIGMA);
            let w = w_depth * w_normal;

            weighted_sum += smp_rc.rgb * w;
            weight_total += w;
        }
    }

    let irradiance      = weighted_sum / max(weight_total, 0.0001);

    // Lambertian diffuse indirect:
    //   L_indirect = irradiance × albedo × (1 − metallic) × (1 − roughness×0.5)
    // The cosine-weighted hemisphere sampling in the trace pass already incorporates
    // the cosine factor, so we only need the BRDF albedo here.
    let diffuse_factor  = (1.0 - metallic) * (1.0 - roughness * 0.5);
    let gi_contribution = irradiance * albedo_rgb * diffuse_factor;

    textureStore(giResult, p, vec4<f32>(gi_contribution, 0.0));
}
