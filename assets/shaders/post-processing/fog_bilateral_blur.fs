// ─── Bilateral Gaussian Blur — Depth-Aware ───────────────────────────────────
//
// Separable Gaussian blur weighted by depth similarity so the blur does not
// bleed across geometric edges.
//
// Used in two roles by FogMultiScatterComponent:
//   1. fogHalfRT blur   (small radius 1-2 px at half-res)  — lateral scatter
//   2. sceneColor blur  (larger radius 4-6 px at quarter-res) — multi-scatter
//
// Bind-group layout:
//   group(0)  SingleTexture  — input texture (RGBA) + sampler
//   group(1)  SingleTexture  — linear depth texture + sampler (for bilateral weight)
//   group(2)  BufferUniform  — FogBilateralBlurParams

// ─── Uniform ──────────────────────────────────────────────────────────────────

// 16 bytes (one vec4)
struct FogBilateralBlurParams {
    direction:  vec2<f32>,  // (1,0) = horizontal pass,  (0,1) = vertical pass
    depthSigma: f32,        // bilateral depth sensitivity (higher = sharper edges)
    radius:     f32,        // kernel half-width in output texels
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

@group(0) @binding(0) var txInput:    texture_2d<f32>;
@group(0) @binding(1) var samplerIn:  sampler;

@group(1) @binding(0) var txDepth:    texture_2d<f32>;
@group(1) @binding(1) var samplerDep: sampler;

@group(2) @binding(0) var<uniform> params: FogBilateralBlurParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    let texelSize    = 1.0 / vec2<f32>(textureDimensions(txInput, 0));
    let centerDepth  = textureSample(txDepth,  samplerDep, uv).r;
    let centerColor  = textureSample(txInput,  samplerIn,  uv);

    // Gaussian sigma derived from radius so the kernel is well-supported.
    let sigma2 = max(params.radius * params.radius * 0.25, 0.001);  // sigma = radius / 2

    var accum       = centerColor;
    var totalWeight = 1.0;

    let numTaps = i32(params.radius);

    for (var i = 1i; i <= numTaps; i++) {
        let fi    = f32(i);
        let off   = params.direction * texelSize * fi;
        let gaussW = exp(-0.5 * fi * fi / sigma2);

        // Positive direction
        let uvP  = uv + off;
        let depP = textureSample(txDepth, samplerDep, uvP).r;
        let wP   = gaussW * exp(-abs(depP - centerDepth) * params.depthSigma);
        accum       += textureSample(txInput, samplerIn, uvP) * wP;
        totalWeight += wP;

        // Negative direction
        let uvN  = uv - off;
        let depN = textureSample(txDepth, samplerDep, uvN).r;
        let wN   = gaussW * exp(-abs(depN - centerDepth) * params.depthSigma);
        accum       += textureSample(txInput, samplerIn, uvN) * wN;
        totalWeight += wN;
    }

    return accum / totalWeight;
}
