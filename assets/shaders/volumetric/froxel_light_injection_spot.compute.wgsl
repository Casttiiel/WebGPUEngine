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
    stepSize: f32,
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
  dimensions: vec4<f32>,   // Grid dimensions (160, 90, 64)
  nearPlane: f32,
  farPlane: f32
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
  _pad:        vec4<f32>,   // bytes 48-63 (padding to 64-byte stride)
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

// Froxel Coordinate Functions - Consolidated from 4 froxel shaders
// This file eliminates duplication and ensures consistency

// ===========================
// DEPTH CONVERSION FUNCTIONS
// ===========================

// Convert froxel Z coordinate to view space depth using logarithmic distribution
fn froxelZToViewZLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z01 = (f32(z) + 0.5) / f32(slices);
  return nearZ * pow(farZ / max(nearZ, 1e-6), z01);
}

// Calculate slice depth delta for logarithmic distribution
fn sliceDzLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32 {
  let z0 = froxelZToViewZLog(z, slices, nearZ, farZ);
  // Extrapolar más allá del último slice en vez de clampear
  let z1 = froxelZToViewZLog(z + 1u, slices, nearZ, farZ);
  return max(z1 - z0, 1e-4);
}

// ===========================
// COORDINATE TRANSFORMATION FUNCTIONS
// ===========================

// Compute view space ray direction from UV coordinates
// Note: Assumes camera uniforms are available with invProjection matrix
fn computeViewRayFromUV(uv: vec2<f32>, invProjection: mat4x4<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = invProjection * ndc;
    return normalize(rayH.xyz / max(rayH.w, 1e-8));
}

// Convert froxel coordinates to view space position
// Requires: FroxelUniforms (dimensions, nearPlane, farPlane)
fn froxelToViewSpace(
    froxel: vec3<u32>, 
    froxelDimensions: vec3<f32>,
    nearPlane: f32,
    farPlane: f32,
    invProjection: mat4x4<f32>
) -> vec3<f32> {
    let dimsU = vec3<u32>(froxelDimensions);

    // UV at center of tile
    var uv = (vec2<f32>(froxel.xy) + vec2<f32>(0.5)) / froxelDimensions.xy;
    uv.y = 1.0 - uv.y;  // Flip Y coordinate
    
    // View ray direction
    let rayVS = computeViewRayFromUV(uv, invProjection);

    // View space depth (positive distance)
    let viewDist = froxelZToViewZLog(froxel.z, dimsU.z, nearPlane, farPlane);

    // Calculate distance along ray
    let t = -viewDist / min(rayVS.z, -1e-6);

    return rayVS * t;
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
    let gg = g * g;
    let denom = pow(1.0 + gg - 2.0 * g * cosTheta, 1.5);
    // Normalización correcta con 4π
    return (1.0 - gg) / (12.566370614 * max(denom, 1e-4)); // 4π ≈ 12.566370614
}
// Shadow mapping utilities - common functions
// Level 3: Depends on core/constants

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;



// Kernel Poisson pre-computado (8 taps, distribución uniforme)
const poissonDisk: array<vec2<f32>, 8> = array<vec2<f32>, 8>(
    vec2<f32>(-0.9450, -0.3165),
    vec2<f32>(-0.6926,  0.5763),
    vec2<f32>(-0.2654, -0.8867),
    vec2<f32>( 0.1566,  0.4173),
    vec2<f32>(-0.1322,  0.9346),
    vec2<f32>( 0.5915, -0.5831),
    vec2<f32>( 0.8743,  0.2891),
    vec2<f32>( 0.3865, -0.1276)
);

fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    
    // Out of bounds check
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    let texelSize = lightShadowStepDivResolution;
    let kernelRadius = texelSize * 1.5;

    // Sin snap — Poisson distribuye los taps de forma que el noise
    // es isotrópico y no produce banding estructural
    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        let offset = poissonDisk[i] * kernelRadius;
        shadow += textureSampleCompareLevel(
            shadowMap, shadowSampler,
            lightUVSpacePos.xy + offset,
            lightUVSpacePos.z
        );
    }
    return shadow / 8.0;
}


// PCF cube shadow for omnidirectional (point) lights.
//
// KEY: the depth stored in each cubemap face was written by a perspective camera
// whose view-space Z equals the *dominant axis component* of dir, not length(dir).
// Using length(dir) for the reference is wrong and causes everything to appear in shadow,
// especially on the faces pointing up/down where horizontal spread makes dist >> faceZ.
fn getShadowFactorCube(
    wPos: vec3<f32>,
    lightPos: vec3<f32>,
    shadowNear: f32,
    shadowFar: f32,
    invResolution: f32,   // 1.0 / shadowResolution — for texel-accurate bias
    shadowCube: texture_depth_cube,
    shadowSampler: sampler_comparison,
) -> f32 {
    let dir  = wPos - lightPos;
    let dist = length(dir);

    // Perspective depth constants (ZO — zero-to-one, matching perspectiveZO)
    let A = shadowFar / (shadowFar - shadowNear);
    let B = -(shadowFar * shadowNear) / (shadowFar - shadowNear); // B < 0

    // Problem 1 fix — texel-accurate bias.
    // 1 texel in world space at a face = 2*faceZ / shadowResolution (FOV 90°).
    // Converting to NDC: dDepth/dfaceZ = |B|/faceZ², so
    //   texelBias = (2*faceZ/res) * |B|/faceZ² = 2*|B| / (res*faceZ)
    // We apply it per-tap below where each tap has its own faceZ.

    // Problem 3 fix — smooth kernel with a guaranteed minimum so it never
    // collapses near the light or explodes far away.
    let kernelRadius = 0.02 * dist + 0.001;

    // Tangent frame built on the ORIGINAL dir (Problem 2 fix — see tap loop).
    let dirN    = normalize(dir);
    let worldUp = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(dirN.y) < 0.99);
    let right   = normalize(cross(dirN, worldUp));
    let up      = normalize(cross(right, dirN));

    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        // Offset applied in original (uncorrected) direction space.
        let tapDir = dir + right * poissonDisk[i].x * kernelRadius
                        + up    * poissonDisk[i].y * kernelRadius;

        // Problem 2 fix — apply the gl-matrix/WebGPU cubemap correction per tap.
        // Every tap may land on a different face, so each needs its own correction:
        //   ±X dominant: negate Z   |   ±Y / ±Z dominant: negate X
        let tapAbs  = abs(tapDir);
        let tapXDom = tapAbs.x >= tapAbs.y && tapAbs.x >= tapAbs.z;
        let tapSampleDir = select(
            vec3<f32>(-tapDir.x,  tapDir.y,  tapDir.z),
            vec3<f32>( tapDir.x,  tapDir.y, -tapDir.z),
            tapXDom
        );

        // Depth and bias computed for this tap's face.
        let tapFaceZ    = max(max(tapAbs.x, tapAbs.y), tapAbs.z);
        let tapFaceZs   = max(tapFaceZ, 0.0001);
        let texelBias   = 2.0 * abs(B) * invResolution / tapFaceZs; // ~1.5 texels
        let tap_depth   = clamp(A + B / tapFaceZs - texelBias * 1.5, 0.0, 1.0);
        let tap_in_range = tapFaceZ >= shadowNear && tapFaceZ <= shadowFar;
        let tap_cmp     = select(0.0, tap_depth, tap_in_range);

        shadow += textureSampleCompare(shadowCube, shadowSampler, tapSampleDir, tap_cmp);
    }
    return shadow / 8.0;
}

fn getShadowFactorSimple(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    
    // Out of bounds check
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    return textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy, lightUVSpacePos.z);
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // read
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // write

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>;
@group(3) @binding(4) var projectorSampler: sampler;

struct LightUniforms {
  color: vec3<f32>,
  hasShadows: f32,
  position: vec3<f32>,   // world
  intensity: f32,
  viewProjOffset: mat4x4<f32>,
  radius: f32,
  shadowStep: f32,
  shadowInverseResolution: f32,
  shadowStepDivResolution: f32,
  startFalloff: f32,
  padding: vec3<f32>,
  extraPadding: f32,
};

fn worldToView(pWS: vec3<f32>) -> vec3<f32> {
  let v = camera.viewMatrix * vec4<f32>(pWS, 1.0);
  return v.xyz;
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let froxelCoord = vec3<i32>(globalId);
    
    // Bounds check
    if (froxelCoord.x >= i32(froxelParams.dimensions.x) ||
        froxelCoord.y >= i32(froxelParams.dimensions.y) ||
        froxelCoord.z >= i32(froxelParams.dimensions.z)) {
        return;
    }

    let coord = vec3<i32>(i32(globalId.x), i32(globalId.y), i32(globalId.z));
    let existing = textureLoad(froxelLightTexture, coord, 0).rgb;
    
    let froxelVS = froxelToViewSpace(
        globalId,
        froxelParams.dimensions.xyz,
        froxelParams.nearPlane,
        froxelParams.farPlane,
        camera.invProjection
    );
    let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
    let froxelWorldPos = tempFroxelWS.xyz / tempFroxelWS.w;
    let almostScreenPos = light.viewProjOffset * vec4<f32>(froxelWorldPos, 1.0);
    let screenPos = almostScreenPos.xyz / almostScreenPos.w;
    // if out of range, shadow_factor = 0
    if (screenPos.x < -1.0 || screenPos.x > 1.0 || screenPos.y < -1.0 || screenPos.y > 1.0 || screenPos.z < 0.0 || screenPos.z > 1.0) {
        textureStore(froxelLightOutput, coord, vec4<f32>(existing, 1.0));
        return;
    }
    var visibility = getShadowFactorSimple(froxelWorldPos.xyz, light.viewProjOffset, light.shadowStepDivResolution, shadowMap, shadowSampler, true);    
    
    let projectorUv = screenPos.xy * 0.5 + 0.5;
    let projector = textureSampleLevel(projectorTexture, projectorSampler, projectorUv.xy, 0.0).r;
    visibility *= projector;

    let light_dir_full = light.position.xyz - froxelWorldPos;
    let distance_to_light = abs(length(light_dir_full));
    let light_dir = light_dir_full / distance_to_light;

    let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
    let Ldir = light_dir;

    let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

    // Forward scattering para god rays marcados
    // g = 0.7-0.8: god rays visibles
    // g = 0.85-0.9: god rays muy marcados (puede ser excesivo)
    let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95) * volumetricSettings.gLightFactor;
    let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
    let phaseMie = phaseHG(cosTheta, g);

    // Peso típico: casi todo Mie para shafts
    let phase = mix(phaseRayleigh, phaseMie, 0.9);

    let d = distance_to_light;
    let r0 = light.startFalloff; // radio interior (intensidad máxima)
    let r1 = light.radius;       // radio exterior (intensidad 0)
    var att = 1.0;
    if (d > r0) {
        // Transición suave de 1.0 a 0.0 entre r0 y r1
        let t = saturate((d - r0) / max(r1 - r0, 0.001));
        // Smoothstep inverso: 1.0 → 0.0
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let distFromCenter = length(screenPos.xy);
    // Zona inner: 0.0 a 0.7 → intensidad máxima
    // Zona outer: 0.7 a 1.0 → fade a 0
    let spotAttenuation = smoothstep(1.0, 0.5, distFromCenter);

    // Aplicar phase function directamente (sin mezclar con isotropic)
    // Esto da god rays claros cuando miras hacia la luz directional
    let contribution = light.color * light.intensity * visibility * phase * att * spotAttenuation;
    
    textureStore(froxelLightOutput, coord, vec4<f32>(existing + contribution, 1.0));
}