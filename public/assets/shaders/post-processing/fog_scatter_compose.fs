// ─── Fog Scatter — Compose Pass ───────────────────────────────────────────────
//
// Final composite of the full fog pipeline onto the scene:
//
//   0. Joint bilateral upsample (Kopf et al. 2007) of the half-res fog, guided by the
//      full-res linear depth, so fog does not bleed/halo across geometric edges.
//   1. Apply raymarch fog:       base = scene * T + fogScatter
//   2. Energy loss:              base *= 1 - energyLoss * fogFac
//   3. SSMS scatter blend:       mix(base, scatter / radius, fogFac * intensity)
//
// The scatter texture is the output of the SSMS pyramid (fog-masked bloom glow).
// maxDensity clamps transmittance so no fragment is fully opaque fog.
//
// Bind groups:
//   group(0)  SingleTexture          — txScene + sampler
//   group(1)  FogScatterFogTextures  — txFogHalfBlurred (scatter.rgb + transmittance.a) + sampler
//                                      + full-res linear depth (JBU guide)
//   group(2)  SingleTexture          — txScatter (SSMS pyramid result) + sampler
//   group(3)  BufferUniform          — FogScatterComposeParams

struct FogScatterComposeParams {
    maxDensity:       f32,   // max fog opacity; clamps T to max(T, 1 - maxDensity)
    energyLoss:       f32,   // scene darkening inside fog (0 = none, 1 = full)
    scatterIntensity: f32,   // final blend strength toward scatter
    scatterRadius:    f32,   // pyramid brightness normalisation divisor
    enabled:          f32,
    depthSensitivity: f32,   // JBU range weight: higher = sharper fog edges at depth gaps
    _p1:              f32,
    _p2:              f32,
}

@group(0) @binding(0) var txScene:        texture_2d<f32>;
@group(0) @binding(1) var samplerScene:   sampler;

@group(1) @binding(0) var txFog:          texture_2d<f32>;
@group(1) @binding(1) var samplerFog:     sampler;
@group(1) @binding(2) var txDepth:        texture_2d<f32>;

@group(2) @binding(0) var txScatter:      texture_2d<f32>;
@group(2) @binding(1) var samplerScatter: sampler;

@group(3) @binding(0) var<uniform> params: FogScatterComposeParams;

// 3×3 low-res taps around the output pixel. Spatial Gaussian on the real sub-texel
// distance × range Gaussian on relative linear-depth difference.
fn upsampleFog(fragCoord: vec2<f32>) -> vec4<f32> {
    let fullDims = vec2<f32>(textureDimensions(txDepth, 0));
    let lowDims  = vec2<f32>(textureDimensions(txFog, 0));
    let lowMax   = vec2<i32>(lowDims) - 1;
    let fullMax  = vec2<i32>(fullDims) - 1;
    let toFull   = fullDims / lowDims;

    let centerDepth = max(textureLoad(txDepth, vec2<i32>(fragCoord), 0).r, 1e-6);
    let lowPos      = fragCoord / toFull - 0.5;        // in low-res texel-centre space
    let lowBase     = vec2<i32>(round(lowPos));

    let depthFactor = -0.5 * params.depthSensitivity * params.depthSensitivity;

    var sum       = vec4<f32>(0.0);
    var sumW      = 0.0;
    var best      = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    var bestDiff  = 1e9;

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let lc  = clamp(lowBase + vec2<i32>(x, y), vec2<i32>(0), lowMax);
            let fog = textureLoad(txFog, lc, 0);

            let fc  = clamp(vec2<i32>((vec2<f32>(lc) + 0.5) * toFull), vec2<i32>(0), fullMax);
            let sd  = textureLoad(txDepth, fc, 0).r;
            let rel = (sd - centerDepth) / centerDepth;

            let d   = vec2<f32>(lc) - lowPos;
            let wS  = exp(-dot(d, d) / (2.0 * 0.8 * 0.8));
            let wR  = exp(rel * rel * depthFactor);
            let w   = wS * wR;

            sum  += fog * w;
            sumW += w;

            if (abs(rel) < bestDiff) { bestDiff = abs(rel); best = fog; }
        }
    }

    // Every tap is across a depth discontinuity → take the closest-depth one
    return select(best, sum / sumW, sumW > 1e-4);
}

@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    let sceneColor = textureSample(txScene, samplerScene, uv).rgb;

    if (params.enabled < 0.5) {
        return vec4<f32>(sceneColor, 1.0);
    }

    let fogSample     = upsampleFog(fragCoord.xy);
    let transmittance = fogSample.a;
    let fogScatter    = fogSample.rgb;

    // Clamp transmittance: maxDensity=0.95 means objects can't vanish fully into fog
    let T      = max(transmittance, 1.0 - params.maxDensity);
    let rawFog = 1.0 - T;

    // Amplify fog factor ×50 so a 2% T-drop (typical low density) maps to ~0.5 rather than ~0.
    // Keeps scatter/energy-loss visible at working density values (0.0005–0.003).
    let fogFac = saturate(rawFog * 50.0);

    // Scene with raymarch single-scatter applied
    var base = sceneColor * T + fogScatter;

    // Energy loss: fog absorbs scene energy (non-physical, artistic)
    base *= 1.0 - params.energyLoss * fogFac;

    // SSMS scatter: lerp toward blurred pyramid glow in foggy areas
    let scatter     = textureSample(txScatter, samplerScatter, uv).rgb;
    let scatterNorm = scatter / max(params.scatterRadius, 0.001);
    let blendFac    = clamp(fogFac * params.scatterIntensity, 0.0, 1.0);

    return vec4<f32>(mix(base, scatterNorm, blendFac), 1.0);
}
