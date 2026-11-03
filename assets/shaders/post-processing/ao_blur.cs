#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"
#include "post-processing/ao_common"

// ---------------------------------------------------------------------------
// Separable depth-aware AO blur — compute shader
// Port of three.js depthAwareBlur (examples/jsm/tsl/display/depthAwareBlur.js):
// 5 taps, Gaussian spatial weight × exp(-|ΔviewZ| / radius · sharpness).
// cs_h: horizontal, cs_v: vertical, cs_v_psx: vertical + Bayer 4×4 stipple (PSX mode).
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: AOParams;
@group(2) @binding(1) var aoInput: texture_2d<f32>;

@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

fn viewZAt(uv: vec2<f32>) -> f32 {
    return -aoSampleDepth(uv) * camera.cameraFar;
}

fn blur(coords: vec2<i32>, dir: vec2<i32>) -> f32 {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let uv      = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);
    let texel   = 1.0 / vec2<f32>(dstSize);

    let centerViewZ = viewZAt(uv);

    var sum       = 0.0;
    var weightSum = 0.0;
    for (var i = -2; i <= 2; i++) {
        let fi       = f32(i);
        let sampleUv = uv + vec2<f32>(dir) * texel * fi;
        let sampleC  = clamp(coords + dir * i, vec2<i32>(0), dstSize - vec2<i32>(1));

        let spatialWeight = exp(fi * fi * -0.5);
        let depthWeight   = exp(-abs(viewZAt(sampleUv) - centerViewZ) / params.radius * params.blurSharpness);
        let weight        = spatialWeight * depthWeight;

        sum       += textureLoad(aoInput, sampleC, 0).b * weight;
        weightSum += weight;
    }
    return sum / max(weightSum, 0.0001);
}

@compute @workgroup_size(8, 8, 1)
fn cs_h(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }
    textureStore(outputAO, coords, aoPack(blur(coords, vec2<i32>(1, 0))));
}

@compute @workgroup_size(8, 8, 1)
fn cs_v(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }
    textureStore(outputAO, coords, aoPack(blur(coords, vec2<i32>(0, 1))));
}

// ── PSX variant — Bayer 4×4 dither applied to the blurred AO ─────────────────
// Thresholds the smooth 0-1 AO against the ordered-dither matrix so the output is a
// hard 0 or 1 per pixel, matching the stippled look of PSX-style rendering.
fn bayer4ao(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

@compute @workgroup_size(8, 8, 1)
fn cs_v_psx(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(gid.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }
    let smoothAO = blur(coords, vec2<i32>(0, 1));
    let dithered = select(0.0, 1.0, smoothAO > bayer4ao(gid.xy));
    textureStore(outputAO, coords, aoPack(dithered));
}
