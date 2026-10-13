#include "common/uniforms"
#include "common/lighting/csm"

// ─── Volumetric God Rays ──────────────────────────────────────────────────────
//
// Per-pixel view-ray march through CSM shadow maps, at half resolution.
//
// The march is bounded so every sample lands where shafts can actually exist:
//   tEnd = min(geometry hit, CSM shadow range, maxDistance)
// Step size is in world units (clamped by maxSteps), so thin occluders aren't
// skipped the way they would be with a fixed step count over the full view.
// Samples fade out near the end of the shadow range so the cut-off is invisible.
//
// Output (rgba16float):
//   r = in-scattered light (unclamped, phase-weighted)
//   g = normalized linear depth of this texel — used by the bilateral blur and
//       the joint-bilateral upsample in the composite pass.
//
// Bind-group layout:
//   group(0)  CameraUniforms       — invProjection, invView, cameraPosition, cameraFar, frameIndex
//   group(1)  GBufferUniforms      — gLinearDepth (binding 2)
//   group(2)  GodRaysVolumetricCSM — DirectionalLightCSMUniforms + 3 shadow maps + sampler
//   group(3)  GodRaysUniforms      — VolumetricGodRaysParams uniform buffer

// ─── Volumetric params ────────────────────────────────────────────────────────
// 8 × f32 = 32 bytes — matches GodRaysUniforms (single uniform buffer).
struct VolumetricGodRaysParams {
    density:     f32,  // σs: scattering coefficient per world unit
    extinction:  f32,  // σt: extinction per world unit (fog transmittance along the view ray)
    anisotropy:  f32,  // Henyey-Greenstein g (0 = isotropic, >0 = forward scattering)
    enabled:     f32,  // 0.0 = skip pass, 1.0 = compute volumetric shafts
    maxSteps:    f32,  // upper bound on raymarch steps
    stepSize:    f32,  // target step length in world units
    maxDistance: f32,  // max march distance from the camera (world units)
    _pad0:       f32,
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Only gLinearDepth (binding 2) is accessed.
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;

// CSM directional light + shadow maps
@group(2) @binding(0) var<uniform> csmLight: DirectionalLightCSMUniforms;
@group(2) @binding(1) var shadowMap0: texture_depth_2d;
@group(2) @binding(2) var shadowMap1: texture_depth_2d;
@group(2) @binding(3) var shadowMap2: texture_depth_2d;
@group(2) @binding(4) var shadowSampler: sampler_comparison;

@group(3) @binding(0) var<uniform> params: VolumetricGodRaysParams;

const PI: f32 = 3.14159265;

// ─── Shadow sampling ──────────────────────────────────────────────────────────
// Select the cascade that covers this view-space depth and sample it.
fn sampleVolumetricShadow(worldPos: vec3<f32>, viewDepth: f32) -> f32 {
    let cascadeIdx = selectCascadeCSM(viewDepth, csmLight.cascadeSplits);
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
// Normalized so that isotropic scattering (g = 0) returns 1.0 — keeps `density`
// meaningful independently of the anisotropy setting.
fn phaseHGRelative(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 0.001);
    return (1.0 - g2) / pow(denom, 1.5);
}

// Interleaved gradient noise, animated per frame so TAA/TSR resolves it.
fn temporalIGN(p: vec2<f32>, frame: f32) -> f32 {
    let q = p + 5.588238 * (frame % 64.0);
    return fract(52.9829189 * fract(dot(q, vec2<f32>(0.06711056, 0.00583715))));
}

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    // ── Pick one full-res depth texel for this half-res texel ────────────────
    // Point-loading (instead of bilinear) avoids averaging depths across edges,
    // and the ray is built through that same texel so depth and ray agree.
    let depthDims = vec2<i32>(textureDimensions(gLinearDepth));
    let depthCoord = clamp(vec2<i32>(uv * vec2<f32>(depthDims)), vec2<i32>(0), depthDims - 1);
    let linearDepth = textureLoad(gLinearDepth, depthCoord, 0).r;

    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, linearDepth, 0.0, 1.0);
    }

    let texelUV = (vec2<f32>(depthCoord) + 0.5) / vec2<f32>(depthDims);

    // ── Reconstruct world-space view ray ─────────────────────────────────────
    let ndc = vec2<f32>(texelUV.x * 2.0 - 1.0, (1.0 - texelUV.y) * 2.0 - 1.0);
    let viewDir4 = camera.invProjection * vec4<f32>(ndc, 1.0, 1.0);
    let viewDir = normalize(viewDir4.xyz / viewDir4.w);
    let worldRayDir = normalize((camera.invView * vec4<f32>(viewDir, 0.0)).xyz);

    // View-space depth per unit of ray length (cosine to the view axis).
    let depthPerT = max(abs(viewDir.z), 1e-3);

    // ── Ray bounds ───────────────────────────────────────────────────────────
    // Geometry hit (linear depth is view-space depth / far; 1.0 = sky).
    let isSky = linearDepth >= 0.9999;
    let tGeometry = select(linearDepth * camera.cameraFar / depthPerT, 1e9, isSky);

    // CSM coverage: beyond the last cascade split there is no shadow data, so any
    // light accumulated there would be a flat, contrast-less haze.
    let cascadeCount = clamp(i32(csmLight.cascadeSplits.w), 1, 3);
    let shadowRange = csmLight.cascadeSplits[cascadeCount - 1];
    let tShadow = shadowRange / depthPerT;

    let tEnd = min(tGeometry, min(tShadow, params.maxDistance));
    if (tEnd <= 0.0) {
        return vec4<f32>(0.0, linearDepth, 0.0, 1.0);
    }

    // ── Step count from world-space step size ────────────────────────────────
    let numSteps = clamp(ceil(tEnd / max(params.stepSize, 0.01)), 4.0, max(params.maxSteps, 4.0));
    let dt = tEnd / numSteps;
    let jitter = temporalIGN(fragCoord.xy, camera.frameIndex);

    // Fade samples over the last 15% of the shadow range / max distance.
    let fadeEnd = min(tShadow, params.maxDistance);
    let fadeStart = fadeEnd * 0.85;

    // ── Raymarch ─────────────────────────────────────────────────────────────
    var scatter = 0.0;
    let steps = i32(numSteps);
    for (var i = 0i; i < steps; i++) {
        let t = (f32(i) + jitter) * dt;
        let worldPos = camera.cameraPosition.xyz + worldRayDir * t;

        let shadow = sampleVolumetricShadow(worldPos, t * depthPerT);
        let fade = 1.0 - smoothstep(fadeStart, fadeEnd, t);
        let transmittance = exp(-params.extinction * t);

        scatter += shadow * fade * transmittance;
    }
    scatter *= params.density * dt;

    // Directional light: the phase angle is constant along the ray.
    // csmLight.position holds the world-space direction *toward* the light.
    let cosTheta = dot(worldRayDir, normalize(csmLight.position));
    scatter *= phaseHGRelative(cosTheta, params.anisotropy);

    return vec4<f32>(scatter, linearDepth, 0.0, 1.0);
}
