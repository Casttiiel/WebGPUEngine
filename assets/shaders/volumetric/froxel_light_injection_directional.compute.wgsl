// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

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

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
}

struct VertexOutputTriplanarLocal {
    @builtin(position) position: vec4<f32>,

    @location(0) @interpolate(perspective, centroid) localNormal: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) localPos: vec3<f32>,
    @location(2) @interpolate(perspective, centroid) worldPos: vec3<f32>,

    // Normal matrix como 3 columnas (col0, col1, col2)
    @location(3) @interpolate(perspective, centroid) normalMatrix0: vec3<f32>,
    @location(4) @interpolate(perspective, centroid) normalMatrix1: vec3<f32>,
    @location(5) @interpolate(perspective, centroid) normalMatrix2: vec3<f32>,
}

struct ShadowsVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) worldPos: vec3<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
    @location(1) normal: vec4<f32>,     // RG: octahedral normal, BA: roughness + emissive
    @location(2) depth: f32,      // Linear depth (view space)
}

struct GBuffer {
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    specularColor: vec3<f32>,
    roughness: f32,
    selfIllum: vec3<f32>,
    emissive: f32,
    reflectedDir: vec3<f32>,
    viewDir: vec3<f32>,
    metallic: f32,
    zlinear: f32,
}

struct MaterialFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,  // decal: blend weight for albedo+normal (1=full, 0=no change)
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,     // decal: blend weight for roughness+metallic (1=full, 0=no change)
    pomScale: f32          // POM height scale (0 = disabled, typical 0.01-0.1)
}

struct SSRUniforms {
    globalAmbientBoost: f32,
    environmentIntensity: f32, // scale of the reflected environment (IBL path)
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    specularBoost: f32,
    diffuseBoost: f32,
    metallicMin: f32,
    roughnessMax: f32,
    temporalMode: f32,  // 1.0 = TAA active (halve march steps), 0.0 = standalone
    frameIndex: f32,    // incremented each frame — drives blue-noise temporal animation
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


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelLightTexture: texture_storage_3d<rgba16float, write>;
@group(2) @binding(1) var<uniform> ambientLight: AmbientLightUniforms;
// Self-occlusion transmittance computed by froxel_self_occlusion pass.
// Value of 1.0 = full light, 0.0 = fully occluded by the medium itself.
@group(2) @binding(2) var froxelSelfOcclusionTexture: texture_3d<f32>;
// Scene linear depth (viewZ / cameraFar, sky = 1) — rejects samples behind geometry.
@group(2) @binding(3) var sceneLinearDepth: texture_2d<f32>;

@group(3) @binding(0) var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(3) @binding(1) var shadowMap0: texture_depth_2d;
@group(3) @binding(2) var shadowMap1: texture_depth_2d;
@group(3) @binding(3) var shadowMap2: texture_depth_2d;
@group(3) @binding(4) var shadowSampler: sampler_comparison;

struct AmbientLightUniforms {
    color: vec3<f32>,
    intensity: f32,
};

// Shader-specific CSM implementation using consolidated functions
fn getShadowFactorCSM(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    
    if (cascadeIndex == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
                directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascadeIndex == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
                directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    } else {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
                directionalLight.shadowParams.z, shadowMap2, shadowSampler);
    }
}

fn getShadowFactorForCascadeIndex(worldPos: vec3<f32>, idx: i32) -> f32 {
    // Call getShadowFactor with appropriate cascade shadow map
    if (idx == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
                directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (idx == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
                directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    } else {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
                directionalLight.shadowParams.z, shadowMap2, shadowSampler);
    }
}

fn getShadowFactorCSMBlended(worldPos: vec3<f32>, viewSpaceDepth: f32) -> f32 {
    let cascadeCount = i32(directionalLight.cascadeSplits.w);
    
    if (cascadeCount == 1) {
        return getShadowFactorForCascadeIndex(worldPos,0);
    }
    
    let blendZone = 2.0; // 2 metros fijos, igual para todas las cascadas
    var cascadeIndex = selectCascadeCSM(viewSpaceDepth, directionalLight.cascadeSplits);
    
    // Calcular split distance de la cascada actual
    var splitDist = directionalLight.cascadeSplits.x;
    if (cascadeIndex == 1) { splitDist = directionalLight.cascadeSplits.y; }
    else if (cascadeIndex == 2) { splitDist = directionalLight.cascadeSplits.z; }
    
    let blendStart = splitDist - blendZone;
    let blendFactor = saturate((viewSpaceDepth - blendStart) / blendZone);
    
    if (blendFactor < 0.01) {
        return getShadowFactorCSM(worldPos, viewSpaceDepth);
    }
    
    // Solo hacer doble lookup en la zona de blend real (2m)
    let shadowFactor1 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex);
    let shadowFactor2 = getShadowFactorForCascadeIndex(worldPos, cascadeIndex + 1);
    return mix(shadowFactor1, shadowFactor2, smoothstep(0.0, 1.0, blendFactor));
}

// Shadow sub-samples per froxel. Far froxels are long in Z (≈1.5 m at 50 m) and
// ~8 px wide, so a single centre tap aliases into stair-steps on diagonal shafts.
// Samples are stratified along the slice depth and spread in XY with an R2
// sequence; froxelParams.jitter rotates the pattern every frame and the temporal
// pass accumulates the result → effectively 4 × history-length samples.
const SHADOW_SAMPLES: u32 = 4u;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let froxelCoord = vec3<i32>(globalId);

    // Bounds check
    if (froxelCoord.x >= i32(froxelParams.dimensions.x) ||
        froxelCoord.y >= i32(froxelParams.dimensions.y) ||
        froxelCoord.z >= i32(froxelParams.dimensions.z)) {
        return;
    }

    // Ambient light color e intensidad desde uniform
    let ambientScattering = ambientLight.color * ambientLight.intensity * volumetricSettings.ambientVolumetricIntensity;
    let directionalScattering = directionalLight.color * directionalLight.intensity;

    let dims = froxelParams.dimensions.xyz;
    let base = vec3<f32>(globalId);
    let jitter = froxelParams.jitter.xyz;

    // Depth-aware sampling: a froxel spans 8×8 pixels, and on surfaces seen at a
    // grazing angle (vaults, floors) part of it lies BEHIND the geometry for some
    // of those pixels — often in lit space on the other side of a wall or roof.
    // No view ray crosses that space at that pixel, so samples there are skipped;
    // otherwise their light leaks onto the surface, hugely amplified by the
    // forward-scattering phase when looking toward the sun.
    let depthDims = vec2<i32>(textureDimensions(sceneLinearDepth));
    let cameraFar = volumetricSettings.windDir.y;

    var visibility = 0.0;
    var validSamples = 0.0;
    for (var i: u32 = 0u; i < SHADOW_SAMPLES; i++) {
        let fi = f32(i);
        let xy = fract(jitter.xy + vec2<f32>(0.7548776662, 0.5698402910) * fi);
        let z  = (fi + jitter.z) / f32(SHADOW_SAMPLES);
        let sampleVS = froxelCoordToViewSpace(base + vec3<f32>(xy, z), dims,
            froxelParams.depthDistScale, froxelParams.depthDistB, camera.invProjection);

        let samplePixel = clamp(vec2<i32>((base.xy + xy) / dims.xy * vec2<f32>(depthDims)),
                                vec2<i32>(0), depthDims - vec2<i32>(1));
        let sceneDepth = textureLoad(sceneLinearDepth, samplePixel, 0).r * cameraFar;
        if (-sampleVS.z > sceneDepth) {
            continue;
        }

        let sampleWS = (camera.invView * vec4<f32>(sampleVS, 1.0)).xyz;
        visibility += getShadowFactorCSMBlended(sampleWS, -sampleVS.z);
        validSamples += 1.0;
    }
    // Froxels entirely behind geometry get no sun (only rays that end further away
    // would use them, and their own samples are valid there).
    visibility /= max(validSamples, 1.0);

    let centreVS = froxelCoordToViewSpace(base + vec3<f32>(0.5), dims,
        froxelParams.depthDistScale, froxelParams.depthDistB, camera.invProjection);
    let froxelWorldPos = (camera.invView * vec4<f32>(centreVS, 1.0)).xyz;

    let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
    let Ldir = normalize(-directionalLight.position);

    let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

    // Forward scattering para god rays marcados
    // g = 0.7-0.8: god rays visibles
    // g = 0.85-0.9: god rays muy marcados (puede ser excesivo)
    let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95);
    let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
    let phaseMie = phaseHG(cosTheta, g);

    // Peso típico: casi todo Mie para shafts
    let phase = mix(phaseRayleigh, phaseMie, 0.9);

    // Self-occlusion: transmittance of the participating medium between this
    // froxel and the directional light source (computed by froxel_self_occlusion pass).
    // 1.0 = full light reaches here, 0.0 = fully occluded by the fog itself.
    let selfShadow = textureLoad(froxelSelfOcclusionTexture, froxelCoord, 0).r;

    // alpha = scalar sun factor (visibility · self-shadow · phase), so that
    // rgb = ambient + sunRadiance · alpha. The raymarch pass uses it to swap the
    // froxel-averaged sun term for an exact per-pixel one in the last, partially
    // covered slice (prevents light from behind surfaces leaking onto them).
    let sunFactor = visibility * selfShadow * phase;
    let scattering = ambientScattering + directionalScattering * sunFactor;

    textureStore(froxelLightTexture, froxelCoord, vec4<f32>(scattering, sunFactor));
}
