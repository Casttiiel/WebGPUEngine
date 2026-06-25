// ─── Fog Scatter — Two-Input Upsample Combine ────────────────────────────────
//
// SSMS pyramid upsample step.  Upsamples a coarser pyramid level (txMain) with
// a 9-tap tent filter, then combines it with the finer base level (txBase):
//
//   output = (base + upsample(main) * (1 + blurWeight)) / (1 + blurWeight * 0.735)
//
// The 0.735 denominator prevents brightness build-up across pyramid levels.
// blurWeight > 1 amplifies the blur, making the scatter softer and wider.
//
// Bind groups:
//   group(0)  SingleTexture  — txMain  (coarser level, source for upsampling)
//   group(1)  SingleTexture  — txBase  (finer level,  accumulation base)
//   group(2)  BufferUniform  — ScatterUpsampleParams

struct ScatterUpsampleParams {
    blurWeight: f32,
    _p0:        f32,
    _p1:        f32,
    _p2:        f32,
}

@group(0) @binding(0) var txMain:      texture_2d<f32>;
@group(0) @binding(1) var samplerMain: sampler;

@group(1) @binding(0) var txBase:      texture_2d<f32>;
@group(1) @binding(1) var samplerBase: sampler;

@group(2) @binding(0) var<uniform> params: ScatterUpsampleParams;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Tap offsets use the coarser texture's texel size → natural 2× upsampling
    let d = 1.0 / vec2<f32>(textureDimensions(txMain, 0));

    // 9-tap tent filter (same as kawase_upsample)
    var blur = textureSample(txMain, samplerMain, uv + vec2(-d.x,  d.y));
    blur    += textureSample(txMain, samplerMain, uv + vec2( 0.0,  d.y)) * 2.0;
    blur    += textureSample(txMain, samplerMain, uv + vec2( d.x,  d.y));
    blur    += textureSample(txMain, samplerMain, uv + vec2(-d.x,  0.0)) * 2.0;
    blur    += textureSample(txMain, samplerMain, uv                   ) * 4.0;
    blur    += textureSample(txMain, samplerMain, uv + vec2( d.x,  0.0)) * 2.0;
    blur    += textureSample(txMain, samplerMain, uv + vec2(-d.x, -d.y));
    blur    += textureSample(txMain, samplerMain, uv + vec2( 0.0, -d.y)) * 2.0;
    blur    += textureSample(txMain, samplerMain, uv + vec2( d.x, -d.y));
    blur    *= (1.0 / 16.0);

    let base = textureSample(txBase, samplerBase, uv);
    let w    = params.blurWeight;

    // SSMS combine: amplify blur by (1+w), normalise to prevent brightness blowout
    return (base + blur * (1.0 + w)) / (1.0 + w * 0.735);
}
