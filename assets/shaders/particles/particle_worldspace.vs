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
    // Scene sun (offset 116 = byte 464): xyz = direction toward the sun, w = 1 if present.
    sunDirection: vec4<f32>,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

#ifdef LIT
// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

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

// ─── Reflection / irradiance probes, per pixel ───────────────────────────────
//
// ProbeManager uploads the probes near the camera (ProbeSet) and keeps every probe's
// GGX-prefiltered cubemap in one cube array. Each pixel blends the probes whose box
// contains it, by a weight that fades `fade` metres either side of the box faces — so
// boxes that tile (auto-placement) cross-fade at their shared face and sum to 1 there.
// Where the weights add up to less than 1, the global environment fills the rest.
//
// Includers declare, with their own group/binding:
//   var<storage, read> probeSet: ProbeSet;
// Specular (cube array) helpers: common/probes_specular.wgsl.

// ─── Parallax Corrected Cubemap (PCC) ────────────────────────────────────────
//
// Standard cubemaps assume the environment is infinitely far away.
// PCC corrects the reflection/normal vector so it "points" to the right
// position inside the probe's AABB, aligning reflections with real room geometry.
//
// Algorithm (Lagarde & de Rousiers, "Physically Based Rendering in Call of Duty",
//            also used extensively in Uncharted 4 interiors):
//
//   1. For each axis, compute the intersection distance with the near and far
//      slab of the AABB: rbmax = (boxMax - P) / R,  rbmin = (boxMin - P) / R
//   2. Per-component, pick the exit slab:
//         if R > 0  →  exit is boxMax slab  (rbmax)
//         if R < 0  →  exit is boxMin slab  (rbmin)
//   3. The actual exit distance is min(rbminmax.xyz)
//   4. posonbox = P + R * fa   ← world-space hit point on the AABB surface
//   5. Return (posonbox - probePos) — direction from probe capture point to
//      that surface hit.  The cubemap was shot from probePos, so this direction
//      indexes the correct texel.
//
// worldPos  – fragment world-space position
// R         – ray direction to correct (should be normalised)
// probePos  – world-space capture/centre position of the probe
// boxMin    – world-space AABB minimum
// boxMax    – world-space AABB maximum
//
// Returns an unnormalised direction (GPU normalises cube samples implicitly).
fn parallaxCorrectDir(
    worldPos : vec3<f32>,
    R        : vec3<f32>,
    probePos : vec3<f32>,
    boxMin   : vec3<f32>,
    boxMax   : vec3<f32>,
) -> vec3<f32> {
    let rbmax    = (boxMax - worldPos) / R;
    let rbmin    = (boxMin - worldPos) / R;
    // Per-component: pick the exit-slab distance based on ray sign
    let rbminmax = select(rbmin, rbmax, R > vec3<f32>(0.0));
    // Smallest exit distance across all three axes
    let fa       = min(min(rbminmax.x, rbminmax.y), rbminmax.z);
    // World-space hit point → direction from probe capture origin
    let posonbox = worldPos + R * fa;
    return posonbox - probePos;
}


struct ProbeGPU {
    pos:    vec4<f32>,             // xyz = capture point, w = 1 outdoor / 2 indoor (PCC)
    boxMin: vec4<f32>,             // xyz = influence box min
    boxMax: vec4<f32>,             // xyz = influence box max, w = cube index (-1 = no env yet)
    fade:   vec4<f32>,             // xyz = cross-fade distance per axis (m)
    sh:     array<vec4<f32>, 9>,   // L2 irradiance (cosine lobe pre-convolved)
}

struct ProbeSet {
    count:       u32,
    hasGlobalSH: u32,
    envMaxMip:   f32,
    ambientScale: f32,                  // ambient boosts (global × diffuse), for forward shading
    globalSH:    array<vec4<f32>, 9>,   // sky / HDR environment irradiance
    gridMin:     vec2<f32>,             // XZ origin of the probe grid
    gridInvCell: vec2<f32>,             // cells per metre
    cellMask:    array<u32, 1024>,      // PROBE_GRID_DIM², bit i = probes[i] overlaps the cell
    probes:      array<ProbeGPU>,
}

const PROBE_GRID_DIM = 32;

// Bitmask of the probes that may weigh at `worldPos` (ProbeManager.buildGrid). Loop it with
//   while (mask != 0u) { let i = firstTrailingBit(mask); mask &= mask - 1u; … }
fn probeMask(worldPos: vec3<f32>) -> u32 {
    let cell = vec2<i32>(floor((worldPos.xz - probeSet.gridMin) * probeSet.gridInvCell));
    if (any(cell < vec2<i32>(0)) || any(cell >= vec2<i32>(PROBE_GRID_DIM))) { return 0u; }
    return probeSet.cellMask[cell.y * PROBE_GRID_DIM + cell.x];
}

fn evalSHProbe(c: array<vec4<f32>, 9>, N: vec3<f32>) -> vec3<f32> {
    let x = N.x; let y = N.y; let z = N.z;
    var r = c[0].rgb * 0.282095;
    r += c[1].rgb * (0.488603 * y);
    r += c[2].rgb * (0.488603 * z);
    r += c[3].rgb * (0.488603 * x);
    r += c[4].rgb * (1.092548 * x * y);
    r += c[5].rgb * (1.092548 * y * z);
    r += c[6].rgb * (0.315392 * (3.0 * z * z - 1.0));
    r += c[7].rgb * (1.092548 * x * z);
    r += c[8].rgb * (0.546274 * (x * x - y * y));
    return max(r, vec3<f32>(0.0));
}

// Per axis: 0 beyond box + fade, 0.5 on the box face, 1 once `fade` inside it. Separate
// fades let grid cells cross-fade wide horizontally while staying sharp at floor level.
// Takes the index, not a ProbeGPU: copying the struct out of the storage buffer loads all
// 13 vec4 (SH included) per probe per pixel, and this runs for every active probe.
fn probeWeight(i: u32, worldPos: vec3<f32>) -> f32 {
    let inside = min(worldPos - probeSet.probes[i].boxMin.xyz, probeSet.probes[i].boxMax.xyz - worldPos);
    let fade = max(probeSet.probes[i].fade.xyz, vec3<f32>(1e-3));
    if (any(inside <= -fade)) { return 0.0; }
    let w = smoothstep(-fade, fade, inside);
    return min(w.x, min(w.y, w.z));
}

struct ProbeIrradiance {
    irradiance: vec3<f32>,
    coverage:   f32,   // how much of it came from probes (0–1)
}

fn probeIrradiance(worldPos: vec3<f32>, N: vec3<f32>) -> ProbeIrradiance {
    var acc  = vec3<f32>(0.0);
    var wsum = 0.0;
    var mask = probeMask(worldPos);
    while (mask != 0u) {
        let i = firstTrailingBit(mask);
        mask &= mask - 1u;
        let w = probeWeight(i, worldPos);
        if (w > 0.0) {
            acc  += evalSHProbe(probeSet.probes[i].sh, N) * w;
            wsum += w;
        }
    }
    var out: ProbeIrradiance;
    out.coverage = min(wsum, 1.0);
    out.irradiance = acc / max(wsum, 1.0);
    if (probeSet.hasGlobalSH != 0u) {
        out.irradiance += evalSHProbe(probeSet.globalSH, N) * (1.0 - out.coverage);
        out.coverage = 1.0;
    }
    return out;
}

// Volumetric Structs - Consolidated from 4 froxel shaders
// This file eliminates 800+ lines of duplicated code

struct FroxelUniforms {
  dimensions: vec4<f32>,      // xyz: grid dimensions, w: debug view (1 = fog only)
  sunPartial: f32,            // 1 = raymarch resolves the last partial slice with an exact per-pixel sun shadow tap
  farPlane: f32,              // depth covered by the grid (view-space metres)
  depthDistScale: f32,        // S in depth(s) = (exp2(s/S) - 1) / B
  depthDistB: f32,            // B
  jitter: vec4<f32>,          // xyz: per-frame sample offset inside the froxel [0,1), w: history weight (0 = reset)
  prevViewProj: mat4x4<f32>,  // previous frame view-projection (temporal reprojection)
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  multipleScatteringBoost: f32,
  anisotropy: f32,
  fogBaseHeight: f32,
  fogLayerHeight: f32,
  fogFalloff: f32,
  ambientVolumetricIntensity: f32,
  gLightFactor: f32,
  renderWidth: f32,
  renderHeight: f32,
  windDir: vec4<f32>,  // pre-scaled wind vector (XZ plane, world units/s); set from Wind singleton
}

// -----------------------------------------------------------------------
// Fog Volume — world-space density region evaluated per-froxel with SDF.
//
// Memory layout (64 bytes, 4 vec4 rows — matches TypeScript Float32Array[16]):
//   row 0  [0..2]  center.xyz       [3]     shape (0=sphere, 1=box)
//   row 1  [4..6]  halfExtents.xyz  [7]     falloff
//   row 2  [8]     density          [9]     sigmaS   [10] sigmaT   [11] blendMode
//   row 3  [12..15] _pad
// -----------------------------------------------------------------------
struct FogVolume {
  center:      vec3<f32>,   // bytes  0-11
  shape:       f32,         // bytes 12-15  — 0=sphere, 1=box
  halfExtents: vec3<f32>,   // bytes 16-27
  falloff:     f32,         // bytes 28-31
  density:     f32,         // bytes 32-35
  sigmaS:      f32,         // bytes 36-39
  sigmaT:      f32,         // bytes 40-43
  blendMode:   f32,         // bytes 44-47  — 0=add, 1=override
  noise:       vec4<f32>,   // bytes 48-63 — x=amount, y=scale (1/m), z=speed (m/s), w=edgeBreakup
}

const MAX_FOG_VOLUMES: u32 = 16u;

// Uniform buffer:  16-byte header (count + 3 × padding u32) + 16 × FogVolume
struct FogVolumeData {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  volumes: array<FogVolume, 16>,
}

// Froxel Coordinate Functions - shared by every froxel pass.
//
// DEPTH DISTRIBUTION
// Slices follow an exponential curve that starts at depth 0 (camera) and ends at
// farPlane (UE-style "linear near, exponential far"):
//
//   depth(s) = (exp2(s / S) - 1) / B          s ∈ [0, N]  (continuous slice coord)
//   s(depth) = S * log2(1 + depth * B)
//
// S = depthDistScale (bigger → more linear), B = (exp2(N / S) - 1) / farPlane.
// A pure log curve (near·(far/near)^t) wastes ~40% of the slices inside the first
// metre and makes the far slices several metres thick — the main source of fog
// leaking through walls. With S = N/2 the slice thickness only grows ~4x from near
// to far.
//
// SLICE / TEXEL CONVENTION
// Slice k spans [depth(k), depth(k+1)].
// Per-froxel data (density, light) is evaluated inside slice k.
// The integrated texture stores at texel k the result from the camera up to the
// FAR boundary depth(k+1), so lookups at depth d use texel coordinate s(d) - 1.

fn froxelSliceToDepth(s: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return (exp2(s / depthDistScale) - 1.0) / depthDistB;
}

fn froxelDepthToSlice(depth: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return depthDistScale * log2(1.0 + max(depth, 0.0) * depthDistB);
}

// Compute view space ray direction (z = -1 plane, NOT normalised) from UV coordinates.
// Note: Assumes camera uniforms are available with invProjection matrix
fn computeViewRayFromUV(uv: vec2<f32>, invProjection: mat4x4<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  let rayH = invProjection * ndc;
  let ray = rayH.xyz / rayH.w;
  // Scale so that ray.z == -1: multiplying by a view depth gives the position.
  return ray / max(-ray.z, 1e-8);
}

// View-space position of a continuous froxel coordinate.
// coord.xy in [0, dims.xy] (froxel centre = index + 0.5), coord.z in [0, dims.z].
// froxel y = 0 is the TOP row of the screen.
fn froxelCoordToViewSpace(
  coord: vec3<f32>,
  froxelDimensions: vec3<f32>,
  depthDistScale: f32,
  depthDistB: f32,
  invProjection: mat4x4<f32>
) -> vec3<f32> {
  var uv = coord.xy / froxelDimensions.xy;
  uv.y = 1.0 - uv.y;
  let ray = computeViewRayFromUV(uv, invProjection);
  let depth = froxelSliceToDepth(coord.z, depthDistScale, depthDistB);
  return ray * depth;
}

// Ratio between the distance travelled along the view ray and the view-depth
// delta for the column through `uvTopDown` (1 at the screen centre, > 1 at edges).
fn froxelRayLengthScale(uvTopDown: vec2<f32>, invProjection: mat4x4<f32>) -> f32 {
  let ray = computeViewRayFromUV(vec2<f32>(uvTopDown.x, 1.0 - uvTopDown.y), invProjection);
  return length(ray);
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let gg = g * g;
  let denom = pow(max(1.0 + gg - 2.0 * g * cosTheta, 1e-4), 1.5);
  return (1.0 - gg) / (12.566370614 * denom); // 4π
}

#endif

// Estructura de la partícula (alineada para storage buffer)
struct Particle {
    position: vec3<f32>,
    padding1: f32,    // Alineamiento
    velocity: vec3<f32>,
    lifetime: f32,    // Tiempo total de vida
    age: f32,         // Edad actual
    alive: u32,      // 1 = viva, 0 = muerta
    padding2: u32,    // Alineamiento
    padding3: u32,    // Alineamiento (total: 48 bytes)
};

// Parámetros de renderizado compartidos entre VS y FS
// (startSize, endSize, startColor, endColor − vienen del componente CPU)
struct ParticleRenderParams {
    startSize:   f32,          // offset  0
    endSize:     f32,          // offset  4
    spinSpeed:   f32,          // offset  8  — giro en pantalla (rad/s máx.)
    tumbleSpeed: f32,          // offset 12  — volteo fingido en 3D (rad/s)
    startColor:  vec4<f32>,    // offset 16
    endColor:    vec4<f32>,    // offset 32
    atlasCols:   f32,          // offset 48  — variantes de la textura (columnas × filas)
    atlasRows:   f32,          // offset 52
    flutter:     f32,          // offset 56  — vaivén lateral (m)
    nearFade:    f32,          // offset 60  — desvanecer cerca de la cámara (m; 0 = no)
    fogEnabled:  f32,          // offset 64  — LIT: 1 = la niebla volumétrica está activa
    translucency: f32,         // offset 68  — LIT: luz del sol que atraviesa el copo (contraluz)
    _pad0:       f32,
    _pad1:       f32,
    // total: 80 bytes
};

/// Azar estable por partícula en [0, 1): mezcla el hueco y la vida (que cambia en cada
/// nacimiento), así un hueco reciclado no repite copo.
fn particleRand(index: u32, lifetime: f32, salt: u32) -> f32 {
    var h = index * 747796405u + bitcast<u32>(lifetime) * 2891336453u + salt * 1181783497u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return f32(h) / 4294967296.0;
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;
@group(3) @binding(1) var<uniform>  renderParams: ParticleRenderParams;

#ifdef LIT
// ── Iluminación por partícula (BindGroupFactory.getParticleLitUniformsLayout) ──
@group(3) @binding(2)  var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(3) @binding(3)  var shadowMap0: texture_depth_2d;
@group(3) @binding(4)  var shadowMap1: texture_depth_2d;
@group(3) @binding(5)  var shadowMap2: texture_depth_2d;
@group(3) @binding(6)  var shadowSampler: sampler_comparison;
@group(3) @binding(7)  var<storage, read> probeSet: ProbeSet;
@group(3) @binding(8)  var fogVolume: texture_3d<f32>;
@group(3) @binding(9)  var<uniform> froxelParams: FroxelUniforms;
@group(3) @binding(10) var fogSampler: sampler;

fn sunShadow(worldPos: vec3<f32>, viewDepth: f32) -> f32 {
    if (directionalLight.hasShadows < 0.5) { return 1.0; }
    let cascade = selectCascadeCSM(viewDepth, directionalLight.cascadeSplits);
    if (cascade == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
            directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascade == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
            directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    }
    return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
        directionalLight.shadowParams.z, shadowMap2, shadowSampler);
}

// Color iluminado de un copo (albedo = color de la partícula) en `center`: sol con su
// sombra (CSM) — difuso de un copo de orientación al azar (½) más el contraluz que lo
// atraviesa (fase HG hacia delante) — y el ambiente de los probes / el cielo.
fn litColor(albedo: vec3<f32>, center: vec3<f32>, viewDepth: f32) -> vec3<f32> {
    let V = normalize(camera.cameraPosition.xyz - center);
    let sunRadiance = directionalLight.color * directionalLight.intensity;
    let cosTheta = dot(V, normalize(-directionalLight.position));
    let forward = phaseHG(cosTheta, 0.6) * 4.0 * PI; // 1 = isótropo
    let sun = sunRadiance * sunShadow(center, viewDepth) * (0.5 + renderParams.translucency * forward);
    // Copo de dos caras: irradiancia hacia la cámara y hacia arriba, promediadas.
    let ambient = (probeIrradiance(center, V).irradiance + probeIrradiance(center, vec3<f32>(0.0, 1.0, 0.0)).irradiance)
                * 0.5 * probeSet.ambientScale;
    return albedo * (sun + ambient) / PI;
}

// Niebla a la profundidad de la partícula: rgb = luz dispersada hasta ella, a = transmitancia.
fn fogAt(clip: vec4<f32>, viewDepth: f32) -> vec4<f32> {
    if (renderParams.fogEnabled < 0.5) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let ndc = clip.xy / clip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let dims = froxelParams.dimensions.xyz;
    let s = froxelDepthToSlice(viewDepth, froxelParams.depthDistScale, froxelParams.depthDistB);
    if (s >= dims.z) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); } // más allá de la rejilla
    // El texel k integra hasta el borde lejano del slice k: profundidad d → s(d) − 1.
    let texelZ = clamp(s - 1.0, 0.0, dims.z - 1.0);
    let f = textureSampleLevel(fogVolume, fogSampler, vec3<f32>(uv, (texelZ + 0.5) / dims.z), 0.0);
    return mix(vec4<f32>(0.0, 0.0, 0.0, 1.0), f, saturate(s));
}
#endif

// Vertex attributes del quad mesh
struct VertexInput {
    @location(0) position: vec3<f32>, // posición del vértice del quad
    @location(1) normal: vec3<f32>,   // normal del quad (no se usa pero está en el mesh)
    @location(2) uv: vec2<f32>,       // UV del quad
    @location(3) tangent: vec4<f32>,  // tangent del quad (no se usa pero está en el mesh)
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>, // Color interpolado (startColor → endColor)
#ifdef LIT
    @location(2) fog: vec4<f32>,           // rgb = dispersión de la niebla, a = transmitancia
#endif
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    // Obtener la partícula actual usando el instance index
    let particle = particles[input.instanceIndex];

    // OPTIMIZACIÓN CRÍTICA: Skip dead particles generando triángulo degenerado
    if (particle.alive == 0u) {
        var output: VertexOutput;
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Degenerate triangle (w=0)
        output.uv = vec2<f32>(0.0, 0.0);
        output.particleColor = vec4<f32>(0.0);
#ifdef LIT
        output.fog = vec4<f32>(0.0, 0.0, 0.0, 1.0);
#endif
        return output;
    }

    // t: fracción de vida [0 = recién nacida, 1 = a punto de morir]
    let t = clamp(particle.age / max(particle.lifetime, 0.0001), 0.0, 1.0);

    // Tamaño interpolado
    let size = mix(renderParams.startSize, renderParams.endSize, t);

    // Color interpolado
    let color = mix(renderParams.startColor, renderParams.endColor, t);

    // Billboarding: extraer vectores right y up de las matrices de cámara
    let cameraRight = normalize(vec3<f32>(camera.viewMatrix[0].x, camera.viewMatrix[1].x, camera.viewMatrix[2].x));
    let cameraUp    = normalize(vec3<f32>(camera.viewMatrix[0].y, camera.viewMatrix[1].y, camera.viewMatrix[2].y));

    // Aspecto propio de cada partícula (como la nieve, las hojas o la ceniza de los juegos):
    // ángulo y giro, volteo, variante del atlas y vaivén, todos con su propio azar.
    let age = particle.age;
    let r0 = particleRand(input.instanceIndex, particle.lifetime, 0u);
    let r1 = particleRand(input.instanceIndex, particle.lifetime, 1u);
    let r2 = particleRand(input.instanceIndex, particle.lifetime, 2u);
    let r3 = particleRand(input.instanceIndex, particle.lifetime, 3u);
    let r4 = particleRand(input.instanceIndex, particle.lifetime, 4u);
    let TAU = 6.2831853;

    // Giro: ángulo inicial al azar, sentido al azar, entre la mitad y la velocidad máxima.
    let spinDir = select(-1.0, 1.0, r1 > 0.5);
    let angle = r0 * TAU + spinDir * (0.5 + 0.5 * r2) * renderParams.spinSpeed * age;
    var corner = input.position.xy;
    // Volteo: se achata en un eje como si girase sobre sí misma (nunca del todo: no desaparece).
    if (renderParams.tumbleSpeed > 0.0) {
        let flip = cos(r3 * TAU + (0.6 + 0.8 * r4) * renderParams.tumbleSpeed * age);
        corner.y *= max(abs(flip), 0.15);
    }
    let ca = cos(angle);
    let sa = sin(angle);
    corner = vec2<f32>(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);

    // Calcular offset del vértice del quad en espacio mundo usando billboarding + tamaño
    let quadOffset = (cameraRight * corner.x + cameraUp * corner.y) * size;

    // WORLD SPACE MODE: Las partículas ya están en coordenadas mundiales
    var worldPos = particle.position + quadOffset;

    // Vaivén lateral al caer (horizontal, en una dirección al azar).
    if (renderParams.flutter > 0.0) {
        let swayDir = vec3<f32>(cos(r0 * TAU), 0.0, sin(r0 * TAU));
        let sway = sin(age * (1.2 + 1.3 * r2) + r4 * TAU) + 0.35 * sin(age * (3.1 + 1.7 * r3));
        worldPos += swayDir * sway * renderParams.flutter;
    }

    let clipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);

    // Variante del atlas.
    var uv = input.uv;
    let cols = max(renderParams.atlasCols, 1.0);
    let rows = max(renderParams.atlasRows, 1.0);
    if (cols * rows > 1.0) {
        let cell = floor(r3 * cols * rows);
        let cellXY = vec2<f32>(cell % cols, floor(cell / cols));
        uv = (uv + cellXY) / vec2<f32>(cols, rows);
    }

    // Cerca de la cámara se desvanece (no tapa la vista con manchas enormes).
    var finalColor = color;
    if (renderParams.nearFade > 0.0) {
        let dist = distance(particle.position, camera.cameraPosition.xyz);
        finalColor.a *= smoothstep(renderParams.nearFade * 0.5, renderParams.nearFade, dist);
    }

    var output: VertexOutput;
#ifdef LIT
    // Una evaluación por partícula (las 4 esquinas dan lo mismo): en su centro.
    let viewDepth = -(camera.viewMatrix * vec4<f32>(particle.position, 1.0)).z;
    finalColor = vec4<f32>(litColor(finalColor.rgb, particle.position, viewDepth), finalColor.a);
    output.fog = fogAt(camera.projectionMatrix * camera.viewMatrix * vec4<f32>(particle.position, 1.0), viewDepth);
#endif
    output.position    = clipPos;
    output.uv          = uv;
    output.particleColor = finalColor;
    
    return output;
}
