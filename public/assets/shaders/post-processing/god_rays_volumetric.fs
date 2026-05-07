#include "common/uniforms"
#include "common/lighting/csm"

// ─── Volumetric God Rays ──────────────────────────────────────────────────────
//
// Per-pixel view-ray march through CSM shadow maps.
// Produces physically-based light shafts that work from ANY camera angle —
// no screen-space sun-position dependency.
//
// Algorithm: for each pixel, reconstruct the world-space view ray, march from
// the camera toward the pixel (up to its geometry depth), and accumulate
// in-scattered light at each step where the CSM shadow factor is non-zero.
// Beer-Lambert transmittance + Henyey-Greenstein phase function.
//
// Bind-group layout:
//   group(0)  CameraUniforms       — invProjection, invView, cameraPosition, cameraFar
//   group(1)  GBufferUniforms      — gLinearDepth (binding 2) used for march termination
//   group(2)  GodRaysVolumetricCSM — DirectionalLightCSMUniforms + 3 shadow maps + sampler
//   group(3)  GodRaysUniforms      — VolumetricGodRaysParams uniform buffer

// ─── Volumetric params ────────────────────────────────────────────────────────
// 8 × f32 = 32 bytes — matches GodRaysUniforms (single uniform buffer).
struct VolumetricGodRaysParams {
    density:    f32,  // σs: scattering coefficient (inscattering strength)
    extinction: f32,  // σt: extinction = σs + σa (opacity per unit distance)
    intensity:  f32,  // final brightness multiplier applied to accumulated light
    enabled:    f32,  // 0.0 = skip pass, 1.0 = compute volumetric shafts
    stepCount:  f32,  // number of raymarch steps (stored as f32)
    _pad0:      f32,
    _pad1:      f32,
    _pad2:      f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Only gLinearDepth (binding 2) and its sampler (binding 3) are accessed.
// Bindings 0 and 1 (gAlbedo, gNormals) are in the bound group but unused here.
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSampler: sampler;

// CSM directional light + shadow maps
@group(2) @binding(0) var<uniform> csmLight: DirectionalLightCSMUniforms;
@group(2) @binding(1) var shadowMap0: texture_depth_2d;
@group(2) @binding(2) var shadowMap1: texture_depth_2d;
@group(2) @binding(3) var shadowMap2: texture_depth_2d;
@group(2) @binding(4) var shadowSampler: sampler_comparison;

@group(3) @binding(0) var<uniform> params: VolumetricGodRaysParams;

// ─── Shadow sampling ──────────────────────────────────────────────────────────
// Select the cascade that covers this view-space distance and sample it.
fn sampleVolumetricShadow(worldPos: vec3<f32>, viewDist: f32) -> f32 {
    let cascadeIdx = selectCascadeCSM(viewDist, csmLight.cascadeSplits);
    if (cascadeIdx == 0) {
        return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset0,
            csmLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascadeIdx == 1) {
        return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset1,
            csmLight.shadowParams.y, shadowMap1, shadowSampler);
    }
    return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset2,
        csmLight.shadowParams.z, shadowMap2, shadowSampler);
}

// ─── Henyey-Greenstein phase ─────────────────────────────────────────────────
// g = 0 → isotropic,  g > 0 → forward scattering (sun glow effect).
fn phaseHG(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 0.001);
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
}

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── Depth termination ────────────────────────────────────────────────────
    // linearDepth is in [0, 1] where 1.0 = sky (clear value = no geometry).
    let linearDepth = textureSample(gLinearDepth, gSampler, uv).r;
    // Don't march into the sky; cap slightly below 1.0 to exclude the far plane.
    let maxWorldDist = min(linearDepth, 0.9999) * camera.cameraFar;

    // ── Reconstruct world-space view ray ─────────────────────────────────────
    // NDC: x ∈ [-1,1], y ∈ [-1,1] (WebGPU y-up convention, UV y-down → flip)
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let clipDir = vec4<f32>(ndc, 1.0, 1.0);
    let viewDir4 = camera.invProjection * clipDir;
    let viewDir = normalize(viewDir4.xyz / viewDir4.w);
    let worldRayDir = normalize((camera.invView * vec4<f32>(viewDir, 0.0)).xyz);

    // ── Phase function setup ─────────────────────────────────────────────────
    // csmLight.position holds the world-space direction *toward* the light.
    let lightDir = normalize(csmLight.position);
    let cosTheta = dot(worldRayDir, lightDir);
    let phase = phaseHG(cosTheta, 0.3); // mild forward scattering

    // ── Interleaved gradient noise dithering ─────────────────────────────────
    // Offsets the first sample per pixel to reduce low-frequency banding.
    let p = fragCoord.xy;
    let dither = fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));

    // ── Raymarch ─────────────────────────────────────────────────────────────
    let numSteps = i32(params.stepCount);
    let stepSize = maxWorldDist / f32(numSteps);

    var accumLight = 0.0;
    var transmittance = 1.0;

    for (var i = 0i; i < numSteps; i++) {
        let t = (f32(i) + dither) * stepSize;
        if (t >= maxWorldDist) { break; }

        let worldPos = camera.cameraPosition.xyz + worldRayDir * t;

        // t ≈ view-space distance (valid approximation for perspective cameras).
        let shadow = sampleVolumetricShadow(worldPos, t);

        // In-scatter: σs × phase × shadow × T × Δt
        accumLight += params.density * phase * shadow * transmittance * stepSize;

        // Beer-Lambert: T *= exp(-σt × Δt)
        transmittance *= exp(-params.extinction * stepSize);

        // Early exit once fully absorbed.
        if (transmittance < 0.005) { break; }
    }

    let result = clamp(accumLight * params.intensity, 0.0, 1.0);
    return vec4<f32>(result, result, result, 1.0);
}
