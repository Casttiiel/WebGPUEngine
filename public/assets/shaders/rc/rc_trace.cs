#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// RCParams — must match RC_PARAMS_SIZE = 48 bytes in RadianceCascades.ts
// ---------------------------------------------------------------------------
struct RCParams {
    cascadeIndex:  f32,   // 0..3
    cascadeCount:  f32,   // 3 or 4
    baseRange:     f32,   // world-space range of cascade 0 (default 0.5)
    intervalStart: f32,   // baseRange × intervalMultStart for this cascade
    intervalEnd:   f32,   // baseRange × intervalMultEnd   for this cascade
    raysPerProbe:  f32,   // 4 / 16 / 64 / 256
    maxSteps:      f32,   // 32 / 24 / 16 / 16
    temporalBlend: f32,   // 0 for c0/c1; 0.9/0.95 for c2/c3 (0 if historyInvalid)
    cascadeRes:    vec2<f32>,  // probe grid size for this cascade
    screenSize:    vec2<f32>,  // full-res screen dimensions
}

// group(0) — CameraUniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1) — GBuffer (compute visibility)
@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// group(2) — RC inputs
@group(2) @binding(0) var<uniform> rc:           RCParams;
@group(2) @binding(1) var rtAccLight:            texture_2d<f32>;
@group(2) @binding(2) var irradianceCubemap:     texture_cube<f32>;
@group(2) @binding(3) var envSampler:            sampler;
@group(2) @binding(4) var historyRT:             texture_2d<f32>;

// group(3) — storage output for this cascade
@group(3) @binding(0) var outputCascade: texture_storage_2d<rgba16float, write>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GOLDEN_RATIO:  f32 = 1.6180339887;
const NORMAL_BIAS:   f32 = 0.015;
const MAX_THICKNESS: f32 = 0.5; // maximum acceptable intersection depth (world units)
const MAX_RADIANCE:  f32 = 10.0; // clamp to prevent bright hits inflating irradiance

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn reconstruct_world_pos(uv: vec2<f32>, linear_depth: f32) -> vec3<f32> {
    let ndc       = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let world_h   = camera.invViewProjection * ndc;
    let world_dir = normalize(world_h.xyz / world_h.w - camera.cameraPosition.xyz);
    // linear_depth = dot(worldPos - camPos, cameraFront) / zFar  →  view-space Z, not ray distance.
    // Divide by the front-projection to convert view-Z to actual ray distance.
    let view_z   = linear_depth * camera.cameraFar;
    let ray_dist = view_z / dot(world_dir, camera.cameraFront.xyz);
    return camera.cameraPosition.xyz + world_dir * ray_dist;
}

fn build_tbn(n: vec3<f32>) -> mat3x3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.999) { up = vec3<f32>(1.0, 0.0, 0.0); }
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    return mat3x3<f32>(t, n, b);
}

// Fibonacci hemisphere distribution with per-probe rotational jitter.
fn cascade_direction(ray_index: u32, num_rays: u32, probe_id: u32, normal: vec3<f32>) -> vec3<f32> {
    // Each probe gets a different rotational offset to reduce banding across probes.
    let rotation_offset = f32(probe_id % 8u) * (TWO_PI / 8.0);
    let i   = f32(ray_index);
    let n   = f32(num_rays);
    let phi   = acos(1.0 - (i + 0.5) / n);           // polar angle [0, π/2]
    let theta = TWO_PI * i * GOLDEN_RATIO + rotation_offset; // azimuth
    let local_dir = vec3<f32>(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    return normalize(build_tbn(normal) * local_dir);
}

fn world_to_screen_uv(world_pos: vec3<f32>) -> vec2<f32> {
    let clip = camera.unjitteredProjectionMatrix * camera.viewMatrix * vec4<f32>(world_pos, 1.0);
    let ndc  = clip.xyz / clip.w;
    return ndc.xy * 0.5 + vec2<f32>(0.5);
}

fn is_in_screen(uv: vec2<f32>) -> bool {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let probe_xy    = vec2<i32>(i32(gid.x), i32(gid.y));
    let cascade_sz  = vec2<i32>(i32(rc.cascadeRes.x), i32(rc.cascadeRes.y));
    if (probe_xy.x >= cascade_sz.x || probe_xy.y >= cascade_sz.y) { return; }

    // Map probe to full-res pixel (nearest-neighbour)
    let scale   = rc.screenSize / rc.cascadeRes;
    let full_px = vec2<i32>(vec2<f32>(probe_xy) * scale);

    // Sample GBuffer at this probe's corresponding full-res pixel
    let depth_val = textureLoad(gLinearDepth, full_px, 0).r;
    if (depth_val <= EPSILON) {
        // Sky pixel — write black, fully "open" (alpha=0 → coarser cascade can fill)
        textureStore(outputCascade, probe_xy, vec4<f32>(0.0));
        return;
    }

    let normals_smp = textureLoad(gNormals, full_px, 0);
    let normal      = decodeOctahedral(normals_smp.xy);

    // Probe UV (centre of probe texel) and world position
    let probe_uv = (vec2<f32>(probe_xy) + 0.5) / rc.cascadeRes;
    let origin   = reconstruct_world_pos(probe_uv, depth_val);

    let num_rays  = u32(rc.raysPerProbe);
    let max_steps = u32(rc.maxSteps);
    let probe_id  = u32(probe_xy.y) * u32(rc.cascadeRes.x) + u32(probe_xy.x);
    let step_size = (rc.intervalEnd - rc.intervalStart) / rc.maxSteps;

    var accum_rgb = vec3<f32>(0.0);
    var ibl_rgb   = vec3<f32>(0.0); // IBL fallback — contributes light but not coverage
    var hit_count = 0u;

    for (var ray_idx = 0u; ray_idx < num_rays; ray_idx++) {
        let dir = cascade_direction(ray_idx, num_rays, probe_id, normal);

        var hit_found = false;
        var hit_uv    = vec2<f32>(0.0);

        for (var step = 0u; step < max_steps; step++) {
            let t            = rc.intervalStart + (f32(step) + 0.5) * step_size;
            let sample_world = origin + normal * NORMAL_BIAS + dir * t;
            let sample_uv    = world_to_screen_uv(sample_world);

            if (!is_in_screen(sample_uv)) { break; }

            let sample_px  = vec2<i32>(sample_uv * rc.screenSize);
            let smp_depth  = textureLoad(gLinearDepth, sample_px, 0).r;

            if (smp_depth <= EPSILON) { continue; } // no geometry

            // Reconstruct depth along ray direction to detect intersection
            let smp_world_pos  = reconstruct_world_pos(sample_uv, smp_depth);
            let dist_ray       = dot(sample_world  - origin, dir);
            let dist_surface   = dot(smp_world_pos - origin, dir);

            // The ray point is slightly behind the surface → intersection
            let behind = dist_ray > dist_surface + 0.001;
            let shallow = dist_ray < dist_surface + MAX_THICKNESS;

            if (behind && shallow) {
                hit_found = true;
                hit_uv    = sample_uv;
                break;
            }
        }

        if (hit_found) {
            let raw = textureSampleLevel(rtAccLight, samplerGBuffer, hit_uv, 0.0).rgb;
            accum_rgb += min(raw, vec3<f32>(MAX_RADIANCE));
            hit_count++;
        } else if (u32(rc.cascadeIndex) == u32(rc.cascadeCount) - 1u) {
            // IBL fallback: only on the coarsest cascade, for rays that escape the frustum.
            // Accumulated separately so it contributes light without inflating coverage alpha —
            // that would incorrectly suppress finer cascades during merge.
            let raw = textureSampleLevel(irradianceCubemap, envSampler, dir, 0.0).rgb;
            ibl_rgb += min(raw, vec3<f32>(MAX_RADIANCE));
        }
        // Finer cascades leave misses as "open" (alpha < 1) — coarser cascade fills via merge
    }

    let out_rgb   = (accum_rgb + ibl_rgb) / f32(num_rays);
    let out_alpha = f32(hit_count) / f32(num_rays); // geometry coverage only — IBL excluded

    var result = vec4<f32>(out_rgb, out_alpha);

    // Temporal accumulation for cascades 2 and 3
    if (rc.temporalBlend > 0.0) {
        let history = textureLoad(historyRT, probe_xy, 0);
        result = mix(result, history, rc.temporalBlend);
    }

    textureStore(outputCascade, probe_xy, result);
}
