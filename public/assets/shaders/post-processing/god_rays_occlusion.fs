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
// 8 × f32 = 32 bytes.
struct GodRaysParams {
    sunNdcX:            f32,  // sun X in NDC [-1, 1]  (reserved for Step 2)
    sunNdcY:            f32,  // sun Y in NDC [-1, 1]  (reserved for Step 2)
    occlusionThreshold: f32,  // luma cutoff for sky detection
    enabled:            f32,  // 0 = skip, 1 = compute mask
    intensity:          f32,  // reserved for Step 2
    density:            f32,  // reserved for Step 2
    decay:              f32,  // reserved for Step 2
    weight:             f32,  // reserved for Step 2
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

    // Read linearDepth from GBuffer.  The GBuffer stores
    //   linearDepth = dot(worldPos - cameraPos, cameraFront) / zFar
    // Sky pixels were never written to by geometry, so they retain the
    // clear value of 1.0 (or very close to it).
    let linearDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).r;

    // Geometry occluder: linearDepth < 1.0 means a surface was rendered here.
    // Output black regardless of HDR brightness (prevents bright geometry like
    // emissive surfaces from leaking into the mask).
    if (linearDepth < 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sky pixel — apply luma threshold on the HDR frame.
    let color = textureSampleLevel(hdrTexture, hdrSampler, uv, 0.0).rgb;

    // Perceptual luminance (ITU-R BT.709).
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));

    let mask = select(0.0, 1.0, luma > params.occlusionThreshold);
    return vec4<f32>(mask, mask, mask, 1.0);
}
