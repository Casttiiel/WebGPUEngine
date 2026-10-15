// ─── Fog Scatter — Prefilter Pass ────────────────────────────────────────────
//
// Prepares the scene for the SSMS pyramid by:
//   1. Anti-flicker 5-tap median filter (removes firefly pixels)
//   2. Brightness threshold + soft-knee (keeps bright / lit areas)
//   3. Fog depth mask (restricts scatter to foggy areas only)
//   4. Tint the result by blurTint
//
// Bind groups:
//   group(0)  SingleTexture          — txScene + sampler
//   group(1)  FogScatterFogTextures  — txFogHalfBlurred (scatter + transmittance) + sampler
//   group(2)  BufferUniform          — ScatterPrefilterParams

struct ScatterPrefilterParams {
    blurTint:  vec3<f32>,   // tint color applied to scattered light
    fadeCurve: f32,          // fog-depth remap exponent (1.0 = linear, >1 = slow)
    threshold: f32,          // brightness threshold (0.0 = pass everything)
    softKnee:  f32,          // knee width as fraction of threshold (0–1)
    _p0:       f32,
    _p1:       f32,
}

@group(0) @binding(0) var txScene:    texture_2d<f32>;
@group(0) @binding(1) var samplerIn:  sampler;

@group(1) @binding(0) var txFog:      texture_2d<f32>;
@group(1) @binding(1) var samplerFog: sampler;

@group(2) @binding(0) var<uniform> params: ScatterPrefilterParams;

fn brightness(c: vec3<f32>) -> f32 {
    return max(max(c.r, c.g), c.b);
}

fn median3(a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> vec3<f32> {
    return a + b + c - min(min(a, b), c) - max(max(a, b), c);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let d = 1.0 / vec2<f32>(textureDimensions(txScene, 0));

    // 5-tap cross median — kills fireflies / specular flickering
    let s0 = textureSample(txScene, samplerIn, uv).rgb;
    let s1 = textureSample(txScene, samplerIn, uv - vec2(d.x, 0.0)).rgb;
    let s2 = textureSample(txScene, samplerIn, uv + vec2(d.x, 0.0)).rgb;
    let s3 = textureSample(txScene, samplerIn, uv - vec2(0.0, d.y)).rgb;
    let s4 = textureSample(txScene, samplerIn, uv + vec2(0.0, d.y)).rgb;
    let m = median3(median3(s0, s1, s2), s3, s4);

    // Brightness threshold with quadratic soft knee (matches SSMS _Curve logic)
    let br   = brightness(m);
    let knee = params.threshold * params.softKnee + 0.00001;
    let rq   = clamp(br - (params.threshold - knee), 0.0, knee * 2.0);
    let rq2  = (0.25 / knee) * rq * rq;
    let filtered = m * max(rq2, br - params.threshold) / max(br, 0.00001);

    // Fog depth mask: transmittance (fog.a) near 1.0 at typical densities, so amplify ×50
    // so a 2% T-drop (density≈0.001 at 500m) maps to ~0.5 mask rather than ~0.
    let fog       = textureSample(txFog, samplerFog, uv);
    let fogAmount = saturate((1.0 - fog.a) * 50.0);
    let mask      = saturate(pow(fogAmount, max(params.fadeCurve, 0.001)));

    return vec4<f32>(filtered * mask * params.blurTint, 1.0);
}
