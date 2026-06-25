#include "common/uniforms"
#include "common/lighting/csm"

// ─── Screen-Space Fog — Single-Scatter Raymarch ───────────────────────────────
//
// Output per pixel: RGBA where RGB = scatter radiance, A = transmittance.
//
// Accumulation per step:
//
//   fogDensity  = heightFog(worldPos) * noiseFactor(worldPos)
//
//   litContrib  = fogDensity * scatterColor * sunColor * intensity * shadowVis
//   baseContrib = fogDensity * fogBaseColor * sunColor * intensity   ← unshadowed sun tint
//
//   accumScatter += (litContrib + baseContrib) * T * stepSize
//   T            *= exp(-fogDensity * extinctionCoeff * stepSize)   [Beer's Law]
//
// Compose pass uses:  scene * T  +  accumScatter    (A = T for depth-blur weight)
//
// Struct layout (80 bytes = 5 × 16):
//   [0-3]  density, heightBase, heightFalloff, extinctionCoeff
//   [4-7]  scatterColor.rgb (offset 16, align 16), numSteps
//   [8-11] fogNear, fogFar, enabled, _pad1
//   [12-15] noiseScale, noiseStrength, windOffsetX, windOffsetZ
//   [16-19] fogBaseColor.rgb (offset 64, align 16), noiseThreshold

struct FogScatterParams {
    density:         f32,
    heightBase:      f32,
    heightFalloff:   f32,
    extinctionCoeff: f32,
    scatterColor:    vec3<f32>,  // lit fog tint  (sun × shadow contribution)
    numSteps:        f32,
    fogNear:         f32,
    fogFar:          f32,
    enabled:         f32,
    _pad1:           f32,
    noiseScale:      f32,        // world-space UV scale
    noiseStrength:   f32,        // 0 = uniform, 1 = full noise
    windOffsetX:     f32,        // accumulated wind scrolling
    windOffsetZ:     f32,
    fogBaseColor:    vec3<f32>,  // unlit fog color (always present, like lerp fog)
    noiseThreshold:  f32,        // cuts noise below this value → distinct fog banks
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera:   CameraUniforms;

@group(1) @binding(2) var gLinearDepth:       texture_2d<f32>;
@group(1) @binding(3) var gSampler:           sampler;

@group(2) @binding(0) var<uniform> csmLight:  DirectionalLightCSMUniforms;
@group(2) @binding(1) var shadowMap0:         texture_depth_2d;
@group(2) @binding(2) var shadowMap1:         texture_depth_2d;
@group(2) @binding(3) var shadowMap2:         texture_depth_2d;
@group(2) @binding(4) var shadowSampler:      sampler_comparison;

@group(3) @binding(0) var<uniform> fogParams: FogScatterParams;
@group(3) @binding(1) var txBlueNoise:        texture_2d<f32>;
@group(3) @binding(2) var samplerNoise:       sampler;

// ─── Point / spot light data (group 4) ───────────────────────────────────────

const MAX_FOG_POINT_LIGHTS: u32 = 32u;
const MAX_FOG_SPOT_LIGHTS:  u32 = 16u;

struct FogLightCounts {
    pointCount: u32,
    spotCount:  u32,
    _p0:        u32,
    _p1:        u32,
}

struct PointLightEntry {
    colorIntensity: vec4<f32>,  // rgb = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = world position, w = outer radius
    falloff:        vec4<f32>,  // x = inner start, yzw = pad
}

struct SpotLightEntry {
    colorIntensity: vec4<f32>,  // rgb = color, w = intensity
    posRadius:      vec4<f32>,  // xyz = world position, w = outer radius
    falloff:        vec4<f32>,  // x = inner start, yzw = pad
    dirCosAngle:    vec4<f32>,  // xyz = forward direction, w = cos(half-angle)
}

@group(3) @binding(3) var<uniform>       fogLightCounts: FogLightCounts;
@group(3) @binding(4) var<storage, read> pointLights:    array<PointLightEntry>;
@group(3) @binding(5) var<storage, read> spotLights:     array<SpotLightEntry>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn lightFalloff(dist: f32, outerRadius: f32, startFalloff: f32) -> f32 {
    if (dist >= outerRadius) { return 0.0; }
    let t = 1.0 - smoothstep(startFalloff, outerRadius, dist);
    return t * t;
}

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

fn evalHeightFog(worldPos: vec3<f32>) -> f32 {
    let h = max(worldPos.y - fogParams.heightBase, 0.0);
    return fogParams.density * exp(-h * fogParams.heightFalloff);
}

// ── Procedural 3D value noise ─────────────────────────────────────────────────
// Works on any world coordinate (including negatives). No texture needed.

fn hash31(p: vec3<f32>) -> f32 {
    var h = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    h += dot(h, h.yzx + 33.33);
    return fract((h.x + h.y) * h.z);
}

fn valueNoise3D(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash31(i),                              hash31(i + vec3<f32>(1,0,0)), u.x),
            mix(hash31(i + vec3<f32>(0,1,0)),          hash31(i + vec3<f32>(1,1,0)), u.x), u.y),
        mix(mix(hash31(i + vec3<f32>(0,0,1)),          hash31(i + vec3<f32>(1,0,1)), u.x),
            mix(hash31(i + vec3<f32>(0,1,1)),          hash31(i + vec3<f32>(1,1,1)), u.x), u.y),
        u.z,
    );
}

// Returns density modulator in [0..1].
// XZ scaled by noiseScale; Y scaled 8× slower → banks are wide/horizontal, not columnar.
// 2-octave FBM: coarse banks (oct 0) + fine tendrils (oct 1).
fn noiseFactor(worldPos: vec3<f32>) -> f32 {
    let p    = vec3<f32>(
                   worldPos.x * fogParams.noiseScale + fogParams.windOffsetX,
                   worldPos.y * fogParams.noiseScale * 0.12,
                   worldPos.z * fogParams.noiseScale + fogParams.windOffsetZ,
               );
    let n0   = valueNoise3D(p);
    let n1   = valueNoise3D(p * 2.17 + vec3<f32>(1.7, 9.2, 3.4)) * 0.5;
    let raw  = n0 * 0.667 + n1 * 0.333;
    let above = max(raw - fogParams.noiseThreshold, 0.0)
              / max(1.0 - fogParams.noiseThreshold, 0.001);
    return mix(1.0, above, fogParams.noiseStrength);
}

// ─── Fragment ─────────────────────────────────────────────────────────────────

@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
    if (fogParams.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    let linearDepth    = textureSample(gLinearDepth, gSampler, uv).r;
    let sceneWorldDist = min(linearDepth, 0.9999) * camera.cameraFar;
    let marchFar       = min(sceneWorldDist, fogParams.fogFar);
    let marchNear      = fogParams.fogNear;

    if (marchFar <= marchNear) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    let ndc      = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let viewDir4 = camera.invProjection * vec4<f32>(ndc, 1.0, 1.0);
    let viewDir  = normalize(viewDir4.xyz / viewDir4.w);
    let rayDir   = normalize((camera.invView * vec4<f32>(viewDir, 0.0)).xyz);

    // Blue noise dither: offsets ray start per-pixel → removes banding
    let noiseUV = fract(fragCoord.xy / 64.0);
    let dither  = textureSampleLevel(txBlueNoise, samplerNoise, noiseUV, 0.0).r;

    let numSteps = i32(max(fogParams.numSteps, 1.0));
    let stepSize = (marchFar - marchNear) / f32(numSteps);

    var accumScatter  = vec3<f32>(0.0);
    var transmittance = 1.0f;

    for (var i = 0i; i < numSteps; i++) {
        let t = marchNear + (f32(i) + dither) * stepSize;
        if (t >= marchFar) { break; }

        let worldPos = camera.cameraPosition.xyz + rayDir * t;

        // Base height fog density, modulated by spatial noise
        let baseDensity = evalHeightFog(worldPos);
        if (baseDensity < 0.00001) { continue; }

        let fogDensity = baseDensity * max(noiseFactor(worldPos), 0.0);
        if (fogDensity < 0.00001) { continue; }

        // ── Lighting (energy-conserving) ──────────────────────────────────────
        // Compute extinction for this step first, then derive scatter weight from it.
        // scatterWeight = T × (1 − e^{−σ·dz})  bounds total accumulation to ≤ sunIntensity,
        // preventing white-out at high densities regardless of stepSize.
        let extinctionStep = exp(-fogDensity * fogParams.extinctionCoeff * stepSize);
        let scatterWeight  = transmittance * (1.0 - extinctionStep);

        let shadowVis   = sampleFogShadow(worldPos, t);
        let litContrib  = fogParams.scatterColor * csmLight.color * csmLight.intensity * shadowVis;
        let baseContrib = fogParams.fogBaseColor  * csmLight.color * csmLight.intensity;

        accumScatter += (litContrib + baseContrib) * scatterWeight;

        // ── Point lights ──────────────────────────────────────────────────────
        for (var pi = 0u; pi < min(fogLightCounts.pointCount, MAX_FOG_POINT_LIGHTS); pi++) {
            let pl   = pointLights[pi];
            let dist = length(pl.posRadius.xyz - worldPos);
            let fa   = lightFalloff(dist, pl.posRadius.w, pl.falloff.x);
            if (fa <= 0.0) { continue; }
            accumScatter += fogParams.scatterColor * pl.colorIntensity.rgb * pl.colorIntensity.w * fa * scatterWeight;
        }

        // ── Spot lights ───────────────────────────────────────────────────────
        for (var si = 0u; si < min(fogLightCounts.spotCount, MAX_FOG_SPOT_LIGHTS); si++) {
            let sl      = spotLights[si];
            let toLight = sl.posRadius.xyz - worldPos;
            let dist    = length(toLight);
            let fa      = lightFalloff(dist, sl.posRadius.w, sl.falloff.x);
            if (fa <= 0.0) { continue; }
            // Cone angle test: toLight/dist points from fragment to light; spot fires along dirCosAngle
            let cosAngle = dot(toLight / max(dist, 0.0001), -sl.dirCosAngle.xyz);
            let cosHalf  = sl.dirCosAngle.w;
            if (cosAngle < cosHalf) { continue; }
            let cone = (cosAngle - cosHalf) / max(1.0 - cosHalf, 0.0001);
            accumScatter += fogParams.scatterColor * sl.colorIntensity.rgb * sl.colorIntensity.w * fa * cone * scatterWeight;
        }

        // Beer's Law extinction
        transmittance *= extinctionStep;

        if (transmittance < 0.005) { break; }
    }

    return vec4<f32>(accumScatter, transmittance);
}
