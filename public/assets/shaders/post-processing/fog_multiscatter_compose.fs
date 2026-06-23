// ─── Screen-Space Fog Multi-Scatter — Compose Pass ───────────────────────────
//
// Combines the raymarch scatter buffer and bilateral-blurred variants into a
// final frame that exhibits two physically-motivated fog effects:
//
//   Effect 1 (scene blur):   objects inside dense fog lose sharpness in
//                             proportion to the real transmittance — not to
//                             distance.  Objects at 30 m behind dense fog
//                             appear blurry; at 30 m with clear sky, sharp.
//
//   Effect 2 (lateral scatter): illuminated regions inside the fog volume
//                             bleed laterally into shadowed regions, producing
//                             a soft gradient instead of a hard shadow cut.
//
// Bind-group layout:
//   group(0)  FogMultiScatterSceneTextures — txScene + txSceneBlurred + sampler
//   group(1)  FogMultiScatterFogTextures   — txFogHalf + txFogHalfBlurred + sampler
//   group(2)  BufferUniform                — FogMultiScatterParams

// ─── Uniform ──────────────────────────────────────────────────────────────────

// 16 bytes — matches FogMultiScatterParams in FogMultiScatterComponent.
struct FogMultiScatterParams {
    lateralScatterStrength: f32,  // 0=no lateral blur, 1=fully blurred scatter
    multiScatterStrength:   f32,  // 0=no scene blur,   1=full transmittance blur
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

@group(2) @binding(0) var<uniform> params: FogMultiScatterParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    let sceneColor   = textureSample(txScene,        samplerScene, uv).rgb;

    if (params.enabled < 0.5) {
        return vec4<f32>(sceneColor, 1.0);
    }

    let sceneBlurred = textureSample(txSceneBlurred, samplerScene, uv).rgb;
    let fogHalf      = textureSample(txFogHalf,      samplerFog,   uv);
    let fogBlurred   = textureSample(txFogHalfBlurred, samplerFog, uv);

    let transmittance = fogHalf.a;

    // Effect 2 — lateral scatter: blend sharp vs blurred scatter buffer.
    // Sharp  = direct sun through fog (hard shadow edges).
    // Blurred = soft light bleeding laterally across shadow boundaries.
    let fogScatter = mix(fogHalf.rgb, fogBlurred.rgb, params.lateralScatterStrength);

    // Effect 1 — scene blur proportional to real transmittance, not distance.
    // blurWeight = 0 → sharp scene (no fog), 1 → fully blurred (opaque fog).
    let blurWeight = saturate((1.0 - transmittance) * params.multiScatterStrength);
    let baseColor  = mix(sceneColor, sceneBlurred, blurWeight);

    // Standard fog composite: attenuate scene by transmittance, add in-scatter.
    let result = baseColor * transmittance + fogScatter;

    return vec4<f32>(result, 1.0);
}
