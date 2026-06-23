// ─── Screen-Space Fog — Compose Pass ─────────────────────────────────────────
//
// Combines the raymarch scatter buffer and bilateral-blurred variants into a
// final frame with two fog effects:
//
//   Effect 1 (scene blur):     objects inside dense fog lose sharpness in
//                               proportion to real transmittance, not distance.
//
//   Effect 2 (lateral scatter): illuminated fog regions bleed laterally into
//                               shadowed areas, softening shadow edges.
//
// Bind-group layout:
//   group(0)  FogScatterSceneTextures — txScene + txSceneBlurred + sampler
//   group(1)  FogScatterFogTextures   — txFogHalf + txFogHalfBlurred + sampler
//   group(2)  BufferUniform           — FogScatterComposeParams

// ─── Uniform ──────────────────────────────────────────────────────────────────

// 16 bytes — matches FogScatterComposeParams in FogScatterComponent.
struct FogScatterComposeParams {
    lateralScatterStrength: f32,  // 0=no lateral blur, 1=fully blurred scatter
    scatterStrength:        f32,  // 0=no scene blur,   1=full transmittance blur
    enabled:                f32,  // 0 = passthrough
    _pad:                   f32,
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

@group(0) @binding(0) var txScene:        texture_2d<f32>;
@group(0) @binding(1) var txSceneBlurred: texture_2d<f32>;
@group(0) @binding(2) var samplerScene:   sampler;

@group(1) @binding(0) var txFogHalf:        texture_2d<f32>;
@group(1) @binding(1) var txFogHalfBlurred: texture_2d<f32>;
@group(1) @binding(2) var samplerFog:       sampler;

@group(2) @binding(0) var<uniform> params: FogScatterComposeParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    let sceneColor = textureSample(txScene, samplerScene, uv).rgb;

    if (params.enabled < 0.5) {
        return vec4<f32>(sceneColor, 1.0);
    }

    let sceneBlurred = textureSample(txSceneBlurred, samplerScene, uv).rgb;
    let fogHalf      = textureSample(txFogHalf,        samplerFog, uv);
    let fogBlurred   = textureSample(txFogHalfBlurred, samplerFog, uv);

    let transmittance = fogHalf.a;

    // Effect 2 — lateral scatter: blend sharp vs blurred scatter.
    let fogScatter = mix(fogHalf.rgb, fogBlurred.rgb, params.lateralScatterStrength);

    // Effect 1 — scene blur proportional to transmittance.
    let blurWeight = saturate((1.0 - transmittance) * params.scatterStrength);
    let baseColor  = mix(sceneColor, sceneBlurred, blurWeight);

    return vec4<f32>(baseColor * transmittance + fogScatter, 1.0);
}
