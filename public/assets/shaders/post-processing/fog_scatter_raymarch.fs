#include "common/uniforms"
#include "common/lighting/csm"

// ─── Screen-Space Fog — Single-Scatter Raymarch Pass ─────────────────────────
//
// Marches each pixel's world-space ray accumulating:
//   - Direct in-scatter: sun light × shadow (bright in sun, zero in shadow)
//   - Ambient in-scatter: sky/bounce light (always present, no shadow)
//
// Output:
//   RGB — accumulated scatter
//   A   — transmittance (1.0 = no fog, 0.0 = opaque)
//
// Bind-group layout:
//   group(0)  CameraUniforms            — invProjection, invView, cameraPos, cameraFar
//   group(1)  GBufferUniforms           — gLinearDepth (binding 2)
//   group(2)  GodRaysVolumetricCSM      — DirectionalLightCSMUniforms + 3 shadow maps
//   group(3)  FogScatterRaymarchUniforms — fogParams uniform + blue-noise texture + sampler

// ─── Uniform structs ──────────────────────────────────────────────────────────

// 64 bytes (4 × vec4) — matches FogScatterParams in FogScatterComponent.
struct FogScatterParams {
    density:         f32,        // base scattering coefficient
    heightBase:      f32,        // world-Y where height fog starts
    heightFalloff:   f32,        // exponential decay rate above heightBase
    extinctionCoeff: f32,        // σt (>= density)
    scatterColor:    vec3<f32>,  // direct sun in-scatter tint
    numSteps:        f32,        // raymarch step count (stored as f32)
    fogNear:         f32,        // march start distance from camera
    fogFar:          f32,        // march end distance (clipped by scene depth)
    enabled:         f32,        // 0.0 = skip pass entirely
    _pad:            f32,
    ambientColor:    vec3<f32>,  // sky/bounce in-scatter (pre-scaled by globalFactor × strength)
    _pad2:           f32,
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSampler:     sampler;

@group(2) @binding(0) var<uniform> csmLight: DirectionalLightCSMUniforms;
@group(2) @binding(1) var shadowMap0:         texture_depth_2d;
@group(2) @binding(2) var shadowMap1:         texture_depth_2d;
@group(2) @binding(3) var shadowMap2:         texture_depth_2d;
@group(2) @binding(4) var shadowSampler:      sampler_comparison;

@group(3) @binding(0) var<uniform> fogParams: FogScatterParams;
@group(3) @binding(1) var txBlueNoise:        texture_2d<f32>;
@group(3) @binding(2) var samplerNoise:       sampler;

// ─── Shadow sampling ──────────────────────────────────────────────────────────

fn sampleFogShadow(worldPos: vec3<f32>, viewDist: f32) -> f32 {
    let cascade = selectCascadeCSM(viewDist, csmLight.cascadeSplits);
    if (cascade == 0) {
        return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset0,
            csmLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascade == 1) {
        return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset1,
            csmLight.shadowParams.y, shadowMap1, shadowSampler);
    }
    return getShadowFactorForCascade(worldPos, csmLight.viewProjOffset2,
        csmLight.shadowParams.z, shadowMap2, shadowSampler);
}

// ─── Height fog density ───────────────────────────────────────────────────────

fn evalHeightFog(worldPos: vec3<f32>) -> f32 {
    let h = max(worldPos.y - fogParams.heightBase, 0.0);
    return fogParams.density * exp(-h * fogParams.heightFalloff);
}

// ─── Fragment entry ───────────────────────────────────────────────────────────

@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    if (fogParams.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── March termination depth ───────────────────────────────────────────────
    let linearDepth    = textureSample(gLinearDepth, gSampler, uv).r;
    let sceneWorldDist = min(linearDepth, 0.9999) * camera.cameraFar;
    let marchFar       = min(sceneWorldDist, fogParams.fogFar);
    let marchNear      = fogParams.fogNear;

    if (marchFar <= marchNear) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // ── Reconstruct world-space view ray ─────────────────────────────────────
    let ndc      = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let clipDir  = vec4<f32>(ndc, 1.0, 1.0);
    let viewDir4 = camera.invProjection * clipDir;
    let viewDir  = normalize(viewDir4.xyz / viewDir4.w);
    let rayDir   = normalize((camera.invView * vec4<f32>(viewDir, 0.0)).xyz);

    // ── Blue-noise dither — textureSampleLevel avoids uniform-flow requirement ─
    let noiseUV = fract(fragCoord.xy / 64.0);
    let dither  = textureSampleLevel(txBlueNoise, samplerNoise, noiseUV, 0.0).r;

    // ── Raymarch ──────────────────────────────────────────────────────────────
    let numSteps = i32(max(fogParams.numSteps, 1.0));
    let stepSize = (marchFar - marchNear) / f32(numSteps);

    var accumScatter  = vec3<f32>(0.0);
    var transmittance = 1.0f;

    for (var i = 0i; i < numSteps; i++) {
        let t = marchNear + (f32(i) + dither) * stepSize;
        if (t >= marchFar) { break; }

        let worldPos   = camera.cameraPosition.xyz + rayDir * t;
        let fogDensity = evalHeightFog(worldPos);

        if (fogDensity < 0.0001) { continue; }

        let shadowVis = sampleFogShadow(worldPos, t);

        // Direct in-scatter: sun light, attenuated by shadow.
        accumScatter += fogDensity * fogParams.scatterColor
                      * csmLight.color * csmLight.intensity
                      * shadowVis * transmittance * stepSize;

        // Ambient in-scatter: sky/bounce light reaches everywhere.
        // ambientColor is pre-scaled by globalFactor × ambientStrength on CPU side.
        accumScatter += fogDensity * fogParams.ambientColor * transmittance * stepSize;

        // Beer-Lambert extinction
        transmittance *= exp(-fogDensity * fogParams.extinctionCoeff * stepSize);

        if (transmittance < 0.005) { break; }
    }

    return vec4<f32>(accumScatter, transmittance);
}
