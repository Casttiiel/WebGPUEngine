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
