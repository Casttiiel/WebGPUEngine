// ─── Fog Scatter — Compose Pass ───────────────────────────────────────────────
//
// Final composite of the full fog pipeline onto the scene:
//
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
//   group(2)  SingleTexture          — txScatter (SSMS pyramid result) + sampler
//   group(3)  BufferUniform          — FogScatterComposeParams

struct FogScatterComposeParams {
    maxDensity:       f32,   // max fog opacity; clamps T to max(T, 1 - maxDensity)
    energyLoss:       f32,   // scene darkening inside fog (0 = none, 1 = full)
    scatterIntensity: f32,   // final blend strength toward scatter
    scatterRadius:    f32,   // pyramid brightness normalisation divisor
    enabled:          f32,
    _p0:              f32,
    _p1:              f32,
    _p2:              f32,
}

@group(0) @binding(0) var txScene:        texture_2d<f32>;
@group(0) @binding(1) var samplerScene:   sampler;

@group(1) @binding(0) var txFog:          texture_2d<f32>;
@group(1) @binding(1) var samplerFog:     sampler;

@group(2) @binding(0) var txScatter:      texture_2d<f32>;
@group(2) @binding(1) var samplerScatter: sampler;

@group(3) @binding(0) var<uniform> params: FogScatterComposeParams;

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    let sceneColor = textureSample(txScene, samplerScene, uv).rgb;

    if (params.enabled < 0.5) {
        return vec4<f32>(sceneColor, 1.0);
    }

    let fogSample     = textureSample(txFog, samplerFog, uv);
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
