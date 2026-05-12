#include "common/uniforms"

// ─── Lens Flare Composite ─────────────────────────────────────────────────────
//
// Step 2 of the screen-space lens flare pipeline.
//
// Reads the quarter-resolution occlusion mask (Step 1) to compute sun
// visibility.  Renders all flare elements additively:
//
//   • Main glow     — large soft gaussian centred on the sun
//   • Corona ring  — thin bright ring at the sun disc edge
//   • Anamorphic   — horizontal streak through the sun (cinema lens look)
//   • Ghost 1–5    — coloured discs scattered along the flare axis
//                     (sun → screen centre → far side)
//
// All elements are modulated by visibility × intensity.
// Pipeline uses ONE+ONE additive blending — no separate destination RT.
//
// Bind-group layout
//   group(0)  CameraUniforms
//   group(1)  Occlusion mask texture + sampler   (SingleTexture)
//   group(2)  LensFlareParams uniform             (GodRaysUniforms layout)

// ─── Params struct ────────────────────────────────────────────────────────────
struct LensFlareParams {
    sunNdcX:    f32,
    sunNdcY:    f32,
    intensity:  f32,
    enabled:    f32,
    sunR:       f32,
    sunG:       f32,
    sunB:       f32,
    ghostScale: f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var occlusionTexture: texture_2d<f32>;
@group(1) @binding(1) var occlusionSampler: sampler;

@group(2) @binding(0) var<uniform> params: LensFlareParams;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Thin ring shape (bright band at `radius`, width `width`).
fn ring(uv: vec2<f32>, centre: vec2<f32>, radius: f32, width: f32) -> f32 {
    let d = abs(length(uv - centre) - radius);
    return 1.0 - smoothstep(0.0, width, d);
}

// Ghost element — soft disc with outer falloff, returns rgb contribution.
fn ghost(
    uv: vec2<f32>,
    pos: vec2<f32>,
    radius: f32,
    color: vec3<f32>,
) -> vec3<f32> {
    let d = length(uv - pos);
    let inner = smoothstep(radius, radius * 0.3, d);  // bright core
    let outer = smoothstep(radius, 0.0, d);           // wide soft halo
    return color * (inner * 0.7 + outer * 0.3);
}

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    let sunColor = vec3<f32>(params.sunR, params.sunG, params.sunB);

    // ── Sun position in UV space ─────────────────────────────────────────────
    let sunUV = vec2<f32>(
        params.sunNdcX *  0.5 + 0.5,
        params.sunNdcY * -0.5 + 0.5,
    );

    // ── Early-out: sun off-screen → skip entirely ───────────────────────────
    // When sunUV is outside [0,1] the occlusion texture is sampled with
    // clamp-to-edge, which can return non-zero values from the screen border
    // (spurious visibility).  Bail out with a small margin instead.
    if (sunUV.x < -0.05 || sunUV.x > 1.05 || sunUV.y < -0.05 || sunUV.y > 1.05) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // ── Visibility: sample occlusion mask near sun ───────────────────────────
    let aspect = camera.screenSize.x / camera.screenSize.y;
    let OCC_SAMPLE_RADIUS: f32 = 0.025;

    // 8-tap ring around sun UV to measure how many sky pixels are visible.
    var visibilitySum: f32 = 0.0;
    let TWO_PI: f32 = 6.28318530718;
    for (var i: i32 = 0; i < 8; i++) {
        let angle = f32(i) * TWO_PI / 8.0;
        let sampleUV = sunUV + vec2<f32>(
            cos(angle) * OCC_SAMPLE_RADIUS / aspect,
            sin(angle) * OCC_SAMPLE_RADIUS,
        );
        visibilitySum += textureSampleLevel(occlusionTexture, occlusionSampler, sampleUV, 0.0).r;
    }
    // Centre sample
    visibilitySum += textureSampleLevel(occlusionTexture, occlusionSampler, sunUV, 0.0).r;
    let visibility = saturate(visibilitySum / 9.0);

    if (visibility < 0.001) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // ── Aspect-corrected UV for shape computations ───────────────────────────
    // Scale x to make shapes round on any screen ratio.
    let uvAR    = vec2<f32>(uv.x * aspect, uv.y);
    let sunAR   = vec2<f32>(sunUV.x * aspect, sunUV.y);
    let centerAR = vec2<f32>(0.5 * aspect, 0.5);

    // Flare axis vector (sun → screen centre, in AR space).
    let flareVec = centerAR - sunAR;

    let gs = params.ghostScale;
    let base = params.intensity * visibility;

    var color: vec3<f32> = vec3<f32>(0.0);

    // ── 1. Main glow ─────────────────────────────────────────────────────────
    let d2sun = length(uvAR - sunAR);
    color += sunColor * exp(-d2sun * d2sun / (0.012 * gs * gs)) * 0.9  * base;
    // Wider diffuse halo
    color += sunColor * exp(-d2sun * d2sun / (0.06  * gs * gs)) * 0.25 * base;

    // ── 2. Corona ring ───────────────────────────────────────────────────────
    color += sunColor * ring(uvAR, sunAR, 0.025 * gs, 0.008 * gs) * 0.4 * base;

    // ── 3. Anamorphic horizontal streak (cinema look) ─────────────────────────
    let sy     = abs(uvAR.y - sunAR.y);
    let sx     = abs(uvAR.x - sunAR.x);
    let streak = exp(-sy * sy / (0.0003 * gs * gs))
               * exp(-sx * sx / (0.5   * gs * gs))
               * 0.3;
    color += sunColor * vec3<f32>(0.7, 0.8, 1.0) * streak * base;

    // ── 4. Ghost discs along the flare axis ──────────────────────────────────
    color += ghost(uvAR, sunAR + flareVec * 0.20, 0.018 * gs, vec3<f32>(0.3, 0.5, 1.0)) * base * 0.55;
    color += ghost(uvAR, sunAR + flareVec * 0.40, 0.030 * gs, vec3<f32>(0.1, 0.9, 0.4)) * base * 0.40;
    color += ghost(uvAR, sunAR + flareVec * 0.60, 0.014 * gs, vec3<f32>(1.0, 0.5, 0.1)) * base * 0.35;
    color += ghost(uvAR, sunAR + flareVec * 0.85, 0.045 * gs, vec3<f32>(0.2, 0.3, 1.0)) * base * 0.30;
    color += ghost(uvAR, sunAR + flareVec * 1.10, 0.022 * gs, vec3<f32>(0.8, 0.2, 0.9)) * base * 0.25;
    color += ghost(uvAR, sunAR + flareVec * 1.40, 0.035 * gs, vec3<f32>(0.9, 0.7, 0.2)) * base * 0.20;

    // ── Edge fade: soften flares when sun is near screen border ──────────────
    let edgeDist = max(abs(params.sunNdcX), abs(params.sunNdcY));
    color       *= 1.0 - smoothstep(0.7, 1.0, edgeDist);

    // Alpha = 0 for additive blend (dst alpha not consumed).
    return vec4<f32>(color, 0.0);
}
