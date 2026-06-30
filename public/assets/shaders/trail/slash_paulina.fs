#include "common/uniforms"

// ── PaulinaVFX attack VFX style — multi-texture slash ───────────────────────
//
// Textures (set via material JSON, provide your own or leave as white.png):
//   txAlbedo   (binding 0) — circular/arc slash shape mask
//   txNormal   (binding 1) — caustic/crystal noise (dissolution at edges)
//   txMetallic (binding 2) — highlight gradient (bright core stripe)
//   txRoughness(binding 3) — crack / energy-line detail
//
// UV convention (from TrailRendererComponent):
//   uv.x = 0 (tip/posA) → 1 (hilt/posB)   across the blade
//   uv.y = 0 (newest)   → 1 (oldest/tail)  along the arc

@group(0) @binding(0) var<uniform> camera:      CameraUniforms;
@group(1) @binding(0) var txShape:    texture_2d<f32>;  // circular slash mask
@group(1) @binding(1) var txCaustic:  texture_2d<f32>;  // caustic noise
@group(1) @binding(2) var txGradient: texture_2d<f32>;  // highlight gradient
@group(1) @binding(3) var txCracks:   texture_2d<f32>;  // crack / energy lines
@group(1) @binding(5) var txSampler:  sampler;

// ── Procedural fallbacks (used when textures are white.png) ─────────────────

fn hash2(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i+vec2(1,0)), u.x),
               mix(hash2(i+vec2(0,1)), hash2(i+vec2(1,1)), u.x), u.y);
}
fn fbm(p: vec2<f32>) -> f32 {
    return vnoise(p) * 0.5 + vnoise(p * 2.1 + vec2(1.7, 9.2)) * 0.25
         + vnoise(p * 4.3 + vec2(8.3, 2.8)) * 0.125;
}

// Voronoi crack-like pattern
fn voronoi(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    var minDist = 8.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let off = vec2<f32>(f32(x), f32(y));
            let pt  = hash2(i + off) * vec2(0.75) + off * 0.5 + 0.25;
            minDist = min(minDist, length(f - pt));
        }
    }
    return minDist;
}

// ── Fragment ─────────────────────────────────────────────────────────────────

@fragment
fn fs(
    @location(0) uv:    vec2<f32>,
    @location(1) color: vec4<f32>,
) -> @location(0) vec4<f32> {

    let t = camera.time;

    // ── 1. Shape mask ─────────────────────────────────────────────────────
    // Circular/arc shaped mask — restricts the slash to an arc area.
    // Procedural fallback: sharp soft oval centred on the ribbon.
    let shapeRaw  = textureSample(txShape, txSampler, uv).r;
    let ovalX = 1.0 - abs(uv.x * 2.0 - 1.0);
    let ovalY = 1.0 - uv.y;
    let procShape = pow(ovalX, 1.4) * ovalY;
    // Blend: if shapeRaw is near 1 (white.png) use procedural, else use texture
    let shape = mix(shapeRaw, procShape, step(0.98, shapeRaw));

    // ── 2. Caustic dissolution (crystal-like noise at edges) ─────────────
    let causticUV  = fract(uv * vec2(2.0, 3.0) + vec2(t * 0.15, -t * 0.1));
    let causticRaw = textureSample(txCaustic, txSampler, causticUV).r;
    let procCaustic = fbm(uv * 4.0 + vec2(t * 0.2, t * 0.13));
    let caustic = mix(causticRaw, procCaustic, step(0.98, causticRaw));

    // ── 3. Highlight gradient (bright stripe along blade centre) ─────────
    let gradUV    = vec2<f32>(uv.x, 0.5); // sample along horizontal centre line
    let gradRaw   = textureSample(txGradient, txSampler, gradUV).r;
    let procGrad  = exp(-pow(abs(uv.x - 0.5) * 3.5, 2.0)); // gaussian at blade centre
    let gradient  = mix(gradRaw, procGrad, step(0.98, gradRaw));

    // ── 4. Crack / energy-line detail ─────────────────────────────────────
    let crackUV  = fract(uv * vec2(1.5, 4.0) + vec2(0.0, -t * 0.35));
    let crackRaw = textureSample(txCracks, txSampler, crackUV).r;
    let procCrack = 1.0 - smoothstep(0.25, 0.45, voronoi(uv * vec2(3.0, 8.0)));
    let cracks    = mix(crackRaw, procCrack, step(0.98, crackRaw));

    // ── Dissolve boundary (caustic dissolves the edge) ────────────────────
    // dissolve = 1 inside the slash, 0 dissolved away
    let dissolveEdge = caustic * 0.35;
    let dissolved    = smoothstep(dissolveEdge, dissolveEdge + 0.12, shape);

    // ── Three-layer colour composition ────────────────────────────────────
    // Base: user tint from CPU (startColor → endColor)
    let tint = color.rgb;

    // Layer 1 — outer coloured glow (driven by shape + caustic)
    let outerVal = dissolved * caustic;
    let outerCol = tint * outerVal;

    // Layer 2 — bright inner streak (gradient × dissolved)
    let innerVal = gradient * dissolved;
    let innerCol = mix(tint, vec3<f32>(1.0), innerVal * 0.8) * innerVal;

    // Layer 3 — white energy cracks on top
    let crackVal = cracks * dissolved * gradient;
    let crackCol = vec3<f32>(1.0) * crackVal * 1.5;

    var col = outerCol + innerCol + crackCol;

    // Flicker (PaulinaVFX charged slash feeling)
    let flicker = 0.85 + 0.15 * sin(t * 28.0) * sin(t * 7.3);
    col *= flicker;

    // ── Head burst ────────────────────────────────────────────────────────
    let headFlash = exp(-uv.y * 9.0);
    col += vec3<f32>(1.0) * headFlash * gradient * 0.8;

    // ── Alpha ─────────────────────────────────────────────────────────────
    let alpha = color.a * dissolved * (outerVal + innerVal * 0.5 + crackVal * 0.3);

    return vec4<f32>(col, clamp(alpha, 0.0, 1.0));
}
