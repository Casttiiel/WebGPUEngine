// Fullscreen composite pass: upscales the low-resolution cloud texture onto
// the accumulation buffer.  The pipeline's depth-equal test ensures this pass
// only runs on sky pixels (depth == 1.0), so clouds never appear over geometry.
//
// Upscaling uses a B-spline cubic (bicubic) filter:
//   - 4 hardware bilinear taps cover the 4×4 kernel neighbourhood
//   - B-spline weights are always positive, enabling the bilinear-tap optimization
//   - Result is visibly sharper than bilinear with no ringing artifacts

@group(1) @binding(0) var cloudTex:     texture_2d<f32>;
@group(1) @binding(1) var cloudSampler: sampler;

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

// B-spline cubic basis weights for a fractional offset f ∈ [0,1].
// Covers 4 texels [i-1, i, i+1, i+2] where i = floor(tc).
// Weights are always non-negative → valid for the 4-tap hardware-bilinear trick.
fn bsplineWeights(f: f32) -> vec4f {
    let f2 = f * f;
    let f3 = f2 * f;
    return vec4f(
        (1.0 - 3.0*f  + 3.0*f2 - f3)      / 6.0,
        (4.0           - 6.0*f2 + 3.0*f3)  / 6.0,
        (1.0 + 3.0*f  + 3.0*f2 - 3.0*f3)  / 6.0,
        f3                                  / 6.0,
    );
}

// Bicubic texture sample using 4 bilinear taps.
// The B-spline 4-tap trick: merge weights into 2 groups per axis, then position
// each bilinear tap so hardware interpolation reproduces the exact weighted sum.
fn sampleBicubic(tex: texture_2d<f32>, samp: sampler, uv: vec2f) -> vec4f {
    let dims    = vec2f(textureDimensions(tex));
    let invDims = 1.0 / dims;

    // Texel-centre coordinates.  Integer values land on texel centres.
    let tc = uv * dims - 0.5;
    let ti = floor(tc);
    let f  = tc - ti;          // fractional offset, [0, 1)

    let wx = bsplineWeights(f.x);
    let wy = bsplineWeights(f.y);

    // Merge into 2 bilinear groups per axis:
    //   Group A = texels (ti-1, ti),   combined weight gA
    //   Group B = texels (ti+1, ti+2), combined weight gB
    let gx = vec2f(wx.x + wx.y, wx.z + wx.w);
    let gy = vec2f(wy.x + wy.y, wy.z + wy.w);

    // Bilinear tap UV for each group.
    // The tap is placed so that the hardware lerp reproduces the correct per-texel split.
    let uvx = vec2f((ti.x - 0.5 + wx.y / gx.x) * invDims.x,
                    (ti.x + 1.5 + wx.w / gx.y) * invDims.x);
    let uvy = vec2f((ti.y - 0.5 + wy.y / gy.x) * invDims.y,
                    (ti.y + 1.5 + wy.w / gy.y) * invDims.y);

    // 4 bilinear taps weighted by group sums
    return (textureSample(tex, samp, vec2f(uvx.x, uvy.x)) * gx.x
          + textureSample(tex, samp, vec2f(uvx.y, uvy.x)) * gx.y) * gy.x
         +(textureSample(tex, samp, vec2f(uvx.x, uvy.y)) * gx.x
          + textureSample(tex, samp, vec2f(uvx.y, uvy.y)) * gx.y) * gy.y;
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    // Derive UV from clip-space NDC so this works at any resolution divisor.
    // NDC x∈[-1,1] → UV x∈[0,1]; NDC y∈[1,-1] → UV y∈[0,1] (WebGPU Y-flip).
    let uv = vec2f(in.position_clip.x * 0.5 + 0.5,
                   0.5 - in.position_clip.y * 0.5);
    return sampleBicubic(cloudTex, cloudSampler, uv);
}
