#include "common/uniforms"
#include "common/octahedral"
#include "common/structs"
#include "common/gbuffer"

// ─── God Rays Occlusion Mask ─────────────────────────────────────────────────
//
// Step 1 of the screen-space god rays pipeline.
//
// Renders a quarter-resolution occlusion mask:
//   - Sky / sun pixels (luma > threshold AND not geometry) → white
//   - Geometry occluders (linearDepth < 1.0)              → black
//
// The GBuffer linearDepth channel is used to distinguish sky from geometry
// without re-rendering the scene.  Sky pixels have linearDepth == 1.0
// (no geometry wrote to them — gbuffer clear value).
//
// Bind-group layout
//   group(0)  CameraUniforms
//   group(1)  GBufferUniforms  (albedo, normals, linearDepth, sampler)
//   group(2)  HDR scene texture + sampler  (SingleTexture)
//   group(3)  GodRaysParams uniform

// ─── Uniform struct ───────────────────────────────────────────────────────────
// 12 × f32 = 48 bytes.
struct GodRaysParams {
    sunNdcX:            f32,  // sun X in NDC [-1, 1]  (reserved for Step 2)
    sunNdcY:            f32,  // sun Y in NDC [-1, 1]  (reserved for Step 2)
    occlusionThreshold: f32,  // luma cutoff for sky detection
    enabled:            f32,  // 0 = skip, 1 = compute mask
    intensity:          f32,  // reserved for Step 2
    density:            f32,  // reserved for Step 2
    decay:              f32,  // reserved for Step 2
    weight:             f32,  // reserved for Step 2
    // Near-depth cutoff: geometry with linearDepth <= nearCutoff is excluded from
    // the screen-space occlusion mask.  The froxel volumetric system (with CSM
    // shadow sampling) handles light shafts through near objects (trees, foliage).
    // Set to 0 to disable the cutoff (all geometry occludes screen-space shafts).
    nearCutoff:         f32,
    // Proximity falloff: sky pixels further than ~(1/sunFalloff) UV from the sun
    // contribute less to the shaft mask.  Prevents a broad fog-like brightening.
    // exp(-dist * sunFalloff): ~4 = wide shafts, ~8 = tight/focused.  0 = no falloff.
    sunFalloff:         f32,
    _pad1:              f32,
    _pad2:              f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// GBuffer — standard layout (group 1)
@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// HDR scene (group 2)
@group(2) @binding(0) var hdrTexture: texture_2d<f32>;
@group(2) @binding(1) var hdrSampler: sampler;

// God rays params (group 3)
@group(3) @binding(0) var<uniform> params: GodRaysParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── Sun screen-space position ──────────────────────────────────────────────
    // WebGPU NDC: x ∈ [-1,1] → u = x*0.5+0.5; y flipped for y-down UV.
    let sunUV = vec2<f32>(
        params.sunNdcX *  0.5 + 0.5,
        params.sunNdcY * -0.5 + 0.5,
    );

    // ── Sun occlusion test ─────────────────────────────────────────────────────
    // If geometry is at the sun's screen-space position (a mountain in front of the
    // sun), suppress the entire mask.  Without this, the procedural sky's bright
    // solar aureole (which extends many pixels around the sun disk) creates a halo
    // even when the sun is fully hidden behind terrain.
    var sunVisibility = 1.0;
    let sunOnScreen = sunUV.x >= 0.0 && sunUV.x <= 1.0 &&
                      sunUV.y >= 0.0 && sunUV.y <= 1.0;
    if (sunOnScreen) {
        let sunLinearDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, sunUV, 0.0).r;
        // 1.0 if sky at sun center (sun visible), 0.0 if geometry covers the sun.
        sunVisibility = step(0.9999, sunLinearDepth);
    }

    // ── Current fragment depth ─────────────────────────────────────────────────
    let linearDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).r;

    // Geometry → black.  Near-depth exclusion: near objects fall through to luma
    // check so the froxel volumetric system handles their beams via CSM shadows.
    let isNear = params.nearCutoff > 0.0 && linearDepth <= params.nearCutoff;
    if (linearDepth < 0.9999 && !isNear) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── Luma threshold ─────────────────────────────────────────────────────────
    let color = textureSampleLevel(hdrTexture, hdrSampler, uv, 0.0).rgb;
    let luma  = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (luma <= params.occlusionThreshold) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── Sun proximity weight ───────────────────────────────────────────────────
    // Prevents fog: sky pixels far from the sun contribute very little to the mask.
    // sunFalloff=0 → no falloff (legacy binary mask); default ~5 gives focused shafts.
    let distToSun  = length(uv - sunUV);
    let proximity  = select(1.0, exp(-distToSun * params.sunFalloff), params.sunFalloff > 0.0);
    let mask       = sunVisibility * proximity;

    return vec4<f32>(mask, mask, mask, 1.0);
}
