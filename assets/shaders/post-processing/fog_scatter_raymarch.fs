struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

// Cascaded Shadow Maps (CSM) - Consolidated from multiple shaders
// This file eliminates 150+ lines of duplicated CSM code

// ===========================
// CSM UNIFORMS STRUCT
// ===========================

struct DirectionalLightCSMUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>,          // Direction towards light
    intensity: f32,
    viewProjOffset0: mat4x4<f32>, // Cascade 0 (near)
    viewProjOffset1: mat4x4<f32>, // Cascade 1 (mid)
    viewProjOffset2: mat4x4<f32>, // Cascade 2 (far)
    cascadeSplits: vec4<f32>,     // x: split0, y: split1, z: split2, w: cascadeCount
    shadowParams: vec4<f32>,      // x: stepDivRes cascade0, y: stepDivRes cascade1, z: stepDivRes cascade2, w: unused
}

// ===========================
// CASCADE SELECTION
// ===========================

/**
 * Selects the appropriate cascade based on view space depth.
 * Returns: cascade index (0, 1, or 2)
 * 
 * @param viewSpaceDepth - Distance from camera in view space
 * @param cascadeSplits - vec4 with split distances (x: split0, y: split1, z: split2, w: cascadeCount)
 */
fn selectCascadeCSM(viewSpaceDepth: f32, cascadeSplits: vec4<f32>) -> i32 {
    let cascadeCount = i32(cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return 0;
    }
    
    if (viewSpaceDepth < cascadeSplits.x) {
        return 0; // Near cascade
    } else if (cascadeCount == 2 || viewSpaceDepth < cascadeSplits.y) {
        return min(1, cascadeCount - 1); // Mid cascade
    } else {
        return min(2, cascadeCount - 1); // Far cascade
    }
}

// ===========================
// RECEIVER HELPERS
// ===========================

/**
 * World-space size of one shadow-map texel for an orthographic cascade.
 * The cascade matrix maps world → [0,1] UV, so |row 0| = 1 / cascadeWidth.
 */
fn csmTexelWorldSize(lightViewProjOffset: mat4x4<f32>, invResolution: f32) -> f32 {
    let rowX = vec3<f32>(lightViewProjOffset[0][0], lightViewProjOffset[1][0], lightViewProjOffset[2][0]);
    return invResolution / max(length(rowX), 1e-8);
}

/**
 * Normal offset for surface receivers: moves the lookup off the surface along
 * its normal, proportionally to the texel footprint and to how grazing the light
 * is. Together with the caster slope bias this removes acne without the light
 * leaks / peter-panning of front-face culling.
 */
fn csmNormalOffset(normal: vec3<f32>, toLight: vec3<f32>, texelWorld: f32) -> vec3<f32> {
    let NdL = saturate(dot(normal, toLight));
    let sinL = sqrt(saturate(1.0 - NdL * NdL));
    return normal * texelWorld * (0.75 + 2.0 * sinL);
}

/** True when worldPos (plus a kernel margin in UV units) is covered by the cascade. */
fn csmCovers(worldPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, marginUV: f32) -> bool {
    let p = lightViewProjOffset * vec4<f32>(worldPos, 1.0);
    let c = p.xyz / p.w;
    return all(c.xy >= vec2<f32>(marginUV)) && all(c.xy <= vec2<f32>(1.0 - marginUV)) &&
           c.z >= 0.0 && c.z <= 1.0;
}

// ===========================
// SHADOW SAMPLING (BASE)
// ===========================

/**
 * Basic shadow tap with depth comparison.
 * Handles boundary checking and returns 1.0 (no shadow) for out-of-bounds coordinates.
 * 
 * @param homo_coord - UV coordinates in shadow map space [0,1]
 * @param coord_z - Depth value to compare against shadow map
 * @param shadowMap - Depth texture to sample
 * @param shadowSampler - Comparison sampler
 */
fn shadowsTapCSM(
    homo_coord: vec2<f32>, 
    coord_z: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison
) -> f32 {
    // Quick optimization: return early for out-of-bounds
    if (homo_coord.x < 0.0 || homo_coord.x > 1.0 ||
        homo_coord.y < 0.0 || homo_coord.y > 1.0) {
        return 1.0; // No shadow
    }

    return textureSampleCompareLevel(shadowMap, shadowSampler, homo_coord, coord_z);
}

// ===========================
// SHADOW FACTOR CALCULATION
// ===========================

/**
 * Calculates shadow factor for a single cascade.
 * Includes UV snapping to eliminate shadow shimmering.
 * 
 * @param wPos - World position
 * @param lightViewProjOffset - ViewProjection matrix for this cascade
 * @param shadowStepDivResolution - Shadow map resolution parameter
 * @param shadowMap - Depth texture
 * @param shadowSampler - Comparison sampler
 */
fn getShadowFactorForCascade(
    wPos: vec3<f32>,
    lightViewProjOffset: mat4x4<f32>,
    shadowStepDivResolution: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison
) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;

    // Check if within valid shadow map range
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0) {
        return 1.0; // Out of depth range = no shadow
    }

    if (lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 || 
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0; // Out of UV range = no shadow
    }

    let uv = lightUVSpacePos.xy;

    return shadowsTapCSM(uv, lightUVSpacePos.z, shadowMap, shadowSampler);
}

// ===========================
// CSM SHADOW FACTOR (NO BLEND)
// ===========================

/**
 * Calculates shadow factor using CSM without cascade blending.
 * Selects the appropriate cascade based on view depth.
 * 
 * NOTE: This is a generic interface - actual implementation needs shadow map parameters.
 * For concrete implementations, see shader-specific versions that pass appropriate shadow maps.
 * 
 * @param worldPos - World space position
 * @param viewSpaceDepth - Distance from camera
 * @param csmUniforms - CSM light uniforms
 */
// This is a template - concrete shaders should implement their own version
// that passes the correct shadow maps (gShadowMap0, gShadowMap1, gShadowMap2)

// ===========================
// CSM SHADOW FACTOR (BLENDED)
// ===========================

/**
 * Calculates shadow factor with smooth blending between cascades.
 * Uses 10% blend region around cascade splits to eliminate hard transitions.
 * 
 * Blend region calculation:
 * - At 90% of split distance: start blending
 * - At 100% of split distance: fully transitioned to next cascade
 * 
 * @param worldPos - World space position
 * @param viewSpaceDepth - Distance from camera
 * @param cascadeSplits - Split distances and count
 * @param blendRegion - Size of blend region (default: 0.1 = 10%)
 * 
 * NOTE: This is a generic interface. Concrete shaders must implement their own
 * getShadowFactorCSMBlended that calls getShadowFactorForCascade with appropriate
 * shadow maps for each cascade.
 */
// Template function - see shader-specific implementations

// ===========================
// DEBUG UTILITIES
// ===========================

/**
 * Returns debug color for cascade visualization:
 * - Cascade 0 (near): Red
 * - Cascade 1 (mid):  Green
 * - Cascade 2 (far):  Blue
 * 
 * @param cascadeIndex - Cascade to visualize (0-2)
 */
fn getCascadeDebugColorCSM(cascadeIndex: i32) -> vec3<f32> {
    if (cascadeIndex == 0) {
        return vec3<f32>(1.0, 0.0, 0.0); // Red - near cascade
    } else if (cascadeIndex == 1) {
        return vec3<f32>(0.0, 1.0, 0.0); // Green - mid cascade
    } else {
        return vec3<f32>(0.0, 0.0, 1.0); // Blue - far cascade
    }
}


// ─── Screen-Space Fog — Single-Scatter Raymarch ───────────────────────────────
//
// Output per pixel: RGBA where RGB = scatter radiance, A = transmittance.
//
// Accumulation per step:
//
//   fogDensity  = heightFog(worldPos) * noiseFactor(worldPos)
//
//   litContrib  = fogDensity * scatterColor * sunColor * intensity * shadowVis * phase
//   baseContrib = fogDensity * fogBaseColor * sunColor * intensity   ← unshadowed sun tint
//
//   accumScatter += (litContrib + baseContrib) * T * stepSize
//   T            *= exp(-fogDensity * extinctionCoeff * stepSize)   [Beer's Law]
//
// Compose pass uses:  scene * T  +  accumScatter    (A = T for depth-blur weight)
//
// Height model (layerHeight):
//   0  → classic unbounded exponential height fog (density * exp(-h * heightFalloff)).
//   >0 → bounded fog slab [.., heightBase + layerHeight] with pow(1 - h/layer, layerFalloff)
//        profile. The ray is clipped to the slab first, so every step lands inside the
//        fog (ray-slab trick from three.js webgpu_postprocessing_fog).
//
// Struct layout (96 bytes = 6 × 16):
//   [0-3]  density, heightBase, heightFalloff, extinctionCoeff
//   [4-7]  scatterColor.rgb (offset 16, align 16), numSteps
//   [8-11] fogNear, fogFar, enabled, _pad1
//   [12-15] noiseScale, noiseStrength, windOffsetX, windOffsetZ
//   [16-19] fogBaseColor.rgb (offset 64, align 16), noiseThreshold
//   [20-23] layerHeight, layerFalloff, anisotropy, noiseWarp

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
    layerHeight:     f32,        // >0 = bounded fog slab thickness above heightBase
    layerFalloff:    f32,        // pow exponent of the slab density profile
    anisotropy:      f32,        // Henyey-Greenstein g for the sun term (0 = isotropic)
    noiseWarp:       f32,        // domain-warp strength of the 2nd noise octave
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
@group(3) @binding(6) var txCloudNoise:                  texture_3d<f32>;
@group(3) @binding(7) var samplerCloudNoise:             sampler;

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
    let h = worldPos.y - fogParams.heightBase;
    if (fogParams.layerHeight > 0.0) {
        let rel = saturate(1.0 - h / fogParams.layerHeight);
        return fogParams.density * pow(rel, fogParams.layerFalloff);
    }
    return fogParams.density * exp(-max(h, 0.0) * fogParams.heightFalloff);
}

// Henyey-Greenstein, scaled by 4π so g = 0 returns 1 (keeps the isotropic look unchanged).
fn fogPhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
    return (1.0 - g2) / (denom * sqrt(denom));
}

// ── Cloud noise (tileable 3D tri-noise texture) ───────────────────────────────
// Returns density modulator: 0 below noiseThreshold, grows above it → distinct banks.
// Octave 2 is domain-warped by octave 1 and drifts against the wind (counter-current)
// so the wisps deform instead of just sliding.
fn noiseFactor(worldPos: vec3<f32>) -> f32 {
    // Wind offsets are wrapped to [0, 4) on the CPU; every multiplier below keeps
    // that wrap an integer number of noise tiles, so the wrap is invisible.
    let wind  = vec3<f32>(fogParams.windOffsetX, 0.0, fogParams.windOffsetZ);
    let p     = worldPos * fogParams.noiseScale;

    let n1 = textureSampleLevel(txCloudNoise, samplerCloudNoise, p + wind, 0.0).r;

    let wind2 = vec3<f32>(-wind.x * 0.5, (wind.x + wind.z) * 0.25, wind.z * 0.5);
    let p2    = p * 2.2 + vec3<f32>(1.7, 0.9, 2.5) + wind2 + n1 * fogParams.noiseWarp;
    let n2    = textureSampleLevel(txCloudNoise, samplerCloudNoise, p2, 0.0).r * 0.5;

    let raw   = n1 + n2;
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

    let ndc      = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let viewDir4 = camera.invProjection * vec4<f32>(ndc, 1.0, 1.0);
    let viewDir  = normalize(viewDir4.xyz / viewDir4.w);
    let rayDir   = normalize((camera.invView * vec4<f32>(viewDir, 0.0)).xyz);

    // Linear depth is view-Z / far; convert to distance along the ray.
    let linearDepth    = textureSample(gLinearDepth, gSampler, uv).r;
    let sceneWorldDist = min(linearDepth, 0.9999) * camera.cameraFar / max(abs(viewDir.z), 1e-4);
    var marchFar       = min(sceneWorldDist, fogParams.fogFar);
    var marchNear      = fogParams.fogNear;

    // Ray-slab: clip the march to the part of the ray below the slab top
    if (fogParams.layerHeight > 0.0) {
        let camY = camera.cameraPosition.y;
        let topY = fogParams.heightBase + fogParams.layerHeight;
        let dirY = select(min(rayDir.y, -1e-5), max(rayDir.y, 1e-5), rayDir.y >= 0.0);
        let tTop = (topY - camY) / dirY;
        if (camY > topY) {
            // Above the slab: only rays going down enter it
            if (rayDir.y >= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
            marchNear = max(marchNear, tTop);
        } else if (rayDir.y > 0.0) {
            // Inside the slab looking up: leave it at the top
            marchFar = min(marchFar, tTop);
        }
    }

    if (marchFar <= marchNear) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sun phase is constant along the ray (directional light)
    let sunDir   = normalize(csmLight.position); // points towards the sun
    let sunPhase = fogPhase(dot(rayDir, sunDir), clamp(fogParams.anisotropy, -0.95, 0.95));

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
        let litContrib  = fogParams.scatterColor * csmLight.color * csmLight.intensity * shadowVis * sunPhase;
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
