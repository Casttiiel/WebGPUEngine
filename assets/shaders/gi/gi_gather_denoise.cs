// ---------------------------------------------------------------------------
// GI final-gather spatial denoise (GIFinalGather.ts): one à-trous iteration (5×5 B3-spline
// taps spaced `step` texels), edge-stopped by the G-buffer at each texel's source pixel
// (relative linear depth, normal similarity), read from the compact guide gi_gather.cs writes. Run twice (steps 1 and 2: a 13×13 footprint) on
// the 1-ray-per-texel gather (rgb = near irradiance, a = escaped share; a < 0 = sky, skipped)
// before gi_resolve.cs accumulates it over time.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(0) @binding(1) var gNormals:       texture_2d<f32>;
@group(0) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(0) @binding(3) var samplerGBuffer: sampler;

struct DenoiseParams {
    step: vec4<u32>,   // x = tap spacing in texels
}
@group(1) @binding(0) var inGather: texture_2d<f32>;
@group(1) @binding(1) var outGather: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var<uniform> params: DenoiseParams;
// Per texel: its source pixel's normal (xyz) and linear depth (w), written by gi_gather.cs.
@group(1) @binding(3) var guide: texture_2d<f32>;

const DEPTH_SIGMA: f32 = 48.0;

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = vec2<i32>(textureDimensions(outGather));
    let p = vec2<i32>(gid.xy);
    if (any(p >= size)) { return; }
    let center = textureLoad(inGather, p, 0);
    if (center.a < 0.0) {
        textureStore(outGather, p, center);
        return;
    }
    let g = textureLoad(guide, p, 0);
    let z = g.w;
    let n = g.xyz;

    var kernel = array<f32, 3>(0.375, 0.25, 0.0625);
    let step = i32(params.step.x);
    var sum = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var y = -2; y <= 2; y++) {
        for (var x = -2; x <= 2; x++) {
            let q = p + vec2<i32>(x, y) * step;
            if (any(q < vec2<i32>(0)) || any(q >= size)) { continue; }
            let s = textureLoad(inGather, q, 0);
            if (s.a < 0.0) { continue; }
            let gq = textureLoad(guide, q, 0);
            let wz = exp(-abs(gq.w - z) / max(z, 1e-4) * DEPTH_SIGMA);
            // pow(cosine, 16) by four squarings.
            var wn = saturate(dot(n, gq.xyz));
            wn *= wn;
            wn *= wn;
            wn *= wn;
            wn *= wn;
            let w = kernel[abs(x)] * kernel[abs(y)] * wz * wn;
            sum += s * w;
            wsum += w;
        }
    }
    textureStore(outGather, p, sum / max(wsum, 1e-6));
}
