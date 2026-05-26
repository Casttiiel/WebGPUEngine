#include "common/uniforms"
#include "common/core/constants"

// ---------------------------------------------------------------------------
// RCParams — same layout as rc_trace.cs (cascadeRes / screenSize here refer
// to the FINE cascade being merged, i.e. the output resolution)
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
    cascadeRes:    vec2<f32>,  // resolution of the FINE (output) cascade
    screenSize:    vec2<f32>,
}

// group(0) — CameraUniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1) — merge inputs
@group(1) @binding(0) var<uniform> rc:       RCParams;
@group(1) @binding(1) var c_fine:            texture_2d<f32>; // traced result of cascade i
@group(1) @binding(2) var c_coarse:          texture_2d<f32>; // traced/merged result of cascade i+1
@group(1) @binding(3) var samplerRC:         sampler;         // bilinear, clamp-to-edge

// group(2) — storage output (merge result at fine resolution)
@group(2) @binding(0) var outputMerge: texture_storage_2d<rgba16float, write>;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Interval-complement merging:
//   merged.rgb = fine.rgb + (1 - fine.a) * coarse.rgb
//   merged.a   = clamp(fine.a + (1 - fine.a) * coarse.a, 0, 1)
//
// fine.a is the coverage fraction (proportion of rays that found a hit).
// The "open" fraction (1 - fine.a) lets the coarser cascade fill in the gap.
// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let probe_xy   = vec2<i32>(i32(gid.x), i32(gid.y));
    let cascade_sz = vec2<i32>(i32(rc.cascadeRes.x), i32(rc.cascadeRes.y));
    if (probe_xy.x >= cascade_sz.x || probe_xy.y >= cascade_sz.y) { return; }

    // Load the fine-cascade sample at this texel
    let c_fine_val = textureLoad(c_fine, probe_xy, 0);

    // Sample the coarse cascade at the same normalised UV.
    // The coarse texture has half the resolution — bilinear filtering interpolates across
    // the 4 nearest coarse probes, giving a smooth weighted average.
    let uv            = (vec2<f32>(probe_xy) + 0.5) / rc.cascadeRes;
    let c_coarse_val  = textureSampleLevel(c_coarse, samplerRC, uv, 0.0);

    // Interval-complement blend
    let open   = 1.0 - c_fine_val.a;
    let merged = vec4<f32>(
        c_fine_val.rgb + open * c_coarse_val.rgb,
        clamp(c_fine_val.a + open * c_coarse_val.a, 0.0, 1.0),
    );

    textureStore(outputMerge, probe_xy, merged);
}
