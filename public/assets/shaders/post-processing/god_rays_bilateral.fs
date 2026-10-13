#include "common/uniforms"

// ─── God Rays Bilateral Blur ──────────────────────────────────────────────────
//
// Separable depth-aware Gaussian over the half-res volumetric buffer.
// Run twice (horizontal, then vertical). Taps whose depth differs from the
// centre are rejected, so the raymarch noise is smoothed without smearing
// shafts across geometry edges (unlike a plain Kawase/box blur).
//
// Input/output layout: r = scatter, g = normalized linear depth (passed through).
//
// Bind-group layout
//   group(0)  CameraUniforms              (standard engine binding)
//   group(1)  Input texture + sampler     (SingleTexture)
//   group(2)  BlurParams uniform          (KawaseUniforms — 16-byte uniform)

// 16 bytes — 4 × f32.
struct BlurParams {
    dirX:       f32,  // texel step direction (1,0) or (0,1)
    dirY:       f32,
    depthSigma: f32,  // relative depth tolerance (e.g. 0.05 = 5 %)
    _pad0:      f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

@group(2) @binding(0) var<uniform> params: BlurParams;

const RADIUS: i32 = 4;
const SPATIAL_SIGMA: f32 = 2.5;

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<i32>(textureDimensions(inputTexture));
    let c = vec2<i32>(fragCoord.xy);
    let center = textureLoad(inputTexture, c, 0);
    let centerDepth = center.g;
    let dir = vec2<i32>(i32(params.dirX), i32(params.dirY));

    let invSpatial = 1.0 / (2.0 * SPATIAL_SIGMA * SPATIAL_SIGMA);
    let invDepth = 1.0 / (2.0 * params.depthSigma * params.depthSigma);

    var sum = 0.0;
    var wSum = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i++) {
        let p = clamp(c + dir * i, vec2<i32>(0), dims - 1);
        let s = textureLoad(inputTexture, p, 0);
        let dz = (s.g - centerDepth) / max(centerDepth, 1e-4);
        let fi = f32(i);
        let w = exp(-fi * fi * invSpatial) * exp(-dz * dz * invDepth);
        sum += s.r * w;
        wSum += w;
    }

    // The centre tap always has weight 1, so wSum >= 1.
    return vec4<f32>(sum / wSum, centerDepth, 0.0, 1.0);
}
