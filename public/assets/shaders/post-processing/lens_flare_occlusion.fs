#include "common/uniforms"

// ─── Lens Flare Occlusion Mask ───────────────────────────────────────────────
//
// Step 1 of the screen-space lens flare pipeline.
//
// Renders a quarter-resolution sky-visibility mask:
//   - Sky pixels near the sun (linearDepth ≈ 1.0) → white
//   - Geometry occluders                           → black
//
// The result is sampled in Step 2 around the sun UV to compute
// how much of the sun disc is visible (occlusion factor [0,1]).
//
// Bind-group layout
//   group(0)  CameraUniforms
//   group(1)  GBufferUniforms  (albedo, normals, linearDepth, sampler)
//   group(2)  LensFlareParams uniform  (GodRaysUniforms layout — single UBO)

// ─── Params struct ────────────────────────────────────────────────────────────
// 8 × f32 = 32 bytes
struct LensFlareParams {
    sunNdcX:    f32,  // Sun X in NDC [-1, 1]
    sunNdcY:    f32,  // Sun Y in NDC [-1, 1]
    intensity:  f32,  // Flare intensity
    enabled:    f32,  // 0 = skip, 1 = active
    sunR:       f32,  // Sun color R
    sunG:       f32,  // Sun color G
    sunB:       f32,  // Sun color B
    ghostScale: f32,  // Ghost element size factor
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: LensFlareParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sun position in UV space.
    let sunUV = vec2<f32>(
        params.sunNdcX *  0.5 + 0.5,
        params.sunNdcY * -0.5 + 0.5,
    );

    // Aspect-corrected distance from current fragment to sun.
    let aspect = camera.screenSize.x / camera.screenSize.y;
    let diff = (uv - sunUV) * vec2<f32>(aspect, 1.0);
    let dist = length(diff);

    // Only write within a radius around the sun disc.
    // Beyond this radius the occlusion mask is black (no flare contribution).
    let OCC_RADIUS: f32 = 0.07;
    if (dist > OCC_RADIUS) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Geometry test: use textureLoad (nearest-neighbor, no bilinear) so wall/sky
    // boundary pixels are never falsely blended to depth >= 1.0.  Bilinear sampling
    // at grazing angles produces averaged depth values that can exceed 0.9999 even
    // for solid geometry, causing the flare to leak through walls.
    let texDims  = textureDimensions(gLinearDepth);
    let texCoord = clamp(
        vec2<i32>(vec2<f32>(texDims) * uv),
        vec2<i32>(0),
        vec2<i32>(texDims) - vec2<i32>(1),
    );
    let linearDepth = textureLoad(gLinearDepth, texCoord, 0).r;
    if (linearDepth < 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sky pixel inside sun disc → white, with smooth falloff toward rim.
    let mask = 1.0 - smoothstep(OCC_RADIUS * 0.5, OCC_RADIUS, dist);
    return vec4<f32>(mask, mask, mask, 1.0);
}
