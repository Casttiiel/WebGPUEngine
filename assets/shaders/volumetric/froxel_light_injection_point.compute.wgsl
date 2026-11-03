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
// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

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


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelDensityTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightTexture: texture_3d<f32>; // read
@group(2) @binding(2) var froxelLightOutput: texture_storage_3d<rgba16float, write>; // write

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var shadowCube: texture_depth_cube;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

// Same layout as point_light_shadow.fs (shadowStep / shadowInverseResolution are
// repurposed as the cube face near / far planes).
struct LightUniforms {
  color: vec3<f32>,
  hasShadows: f32,
  position: vec3<f32>,   // world
  intensity: f32,
  viewProjOffset: mat4x4<f32>,
  radius: f32,
  shadowNear: f32,
  shadowFar: f32,
  shadowStepDivResolution: f32,
  startFalloff: f32,
  padding: vec3<f32>,
  extraPadding: f32,
};

// Single-tap cube shadow (compute-safe: textureSampleCompareLevel).
// The cube faces store perspective depth whose view Z is the dominant axis of
// the light→point vector; see getShadowFactorCube in common/lighting/shadows.
fn pointShadow(wPos: vec3<f32>) -> f32 {
  let dir = wPos - light.position;
  let a = abs(dir);
  let faceZ = max(max(a.x, a.y), a.z);
  if (faceZ < light.shadowNear || faceZ > light.shadowFar) {
    return 1.0;
  }
  let A = light.shadowFar / (light.shadowFar - light.shadowNear);
  let B = -(light.shadowFar * light.shadowNear) / (light.shadowFar - light.shadowNear);
  // Small constant bias in depth units — fog has no surface acne to fight.
  let depth = clamp(A + B / faceZ - 0.0005, 0.0, 1.0);
  let xDom = a.x >= a.y && a.x >= a.z;
  let sampleDir = select(vec3<f32>(-dir.x, dir.y, dir.z), vec3<f32>(dir.x, dir.y, -dir.z), xDom);
  return textureSampleCompareLevel(shadowCube, shadowSampler, sampleDir, depth);
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimsU = vec3<u32>(froxelParams.dimensions.xyz);

  if (gid.x >= dimsU.x || gid.y >= dimsU.y || gid.z >= dimsU.z) {
    return;
  }

  let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z));

  let existing = textureLoad(froxelLightTexture, coord, 0); // .a = sun factor, passed through

  // Jittered sample inside the froxel — the temporal pass integrates it.
  let froxelVS = froxelCoordToViewSpace(
    vec3<f32>(gid) + froxelParams.jitter.xyz,
    froxelParams.dimensions.xyz,
    froxelParams.depthDistScale,
    froxelParams.depthDistB,
    camera.invProjection
  );
  let froxelWorldPos = (camera.invView * vec4<f32>(froxelVS, 1.0)).xyz;

  let lightVec = light.position - froxelWorldPos;
  let d = length(lightVec);

  // fuera del radio => copiar
  if (d >= light.radius) {
    textureStore(froxelLightOutput, coord, existing);
    return;
  }

  var visibility = 1.0;
  if (light.hasShadows > 0.5) {
    visibility = pointShadow(froxelWorldPos);
  }

  let V = normalize(camera.cameraPosition.xyz - froxelWorldPos);
  let Ldir = lightVec / max(d, 1e-4);

  let cosTheta = clamp(dot(V, Ldir), -1.0, 1.0);

  let g = clamp(volumetricSettings.anisotropy, -0.95, 0.95) * volumetricSettings.gLightFactor;
  let phaseRayleigh = 1.0 / (4.0 * PI);   // isotrópico real
  let phaseMie = phaseHG(cosTheta, g);

  // Peso típico: casi todo Mie para shafts
  let phase = mix(phaseRayleigh, phaseMie, 0.9);

  let r0 = light.startFalloff; // radio interior (intensidad máxima)
  let r1 = light.radius;       // radio exterior (intensidad 0)

  // Atenuación con inner/outer radius
  var att = 1.0;
  if (d > r0) {
      // Transición suave de 1.0 a 0.0 entre r0 y r1
      let t = saturate((d - r0) / max(r1 - r0, 0.001));
      // Smoothstep inverso: 1.0 → 0.0
      att = 1.0 - t * t * (3.0 - 2.0 * t);
  }

  let contribution = light.color * light.intensity * att * phase * visibility;

  textureStore(froxelLightOutput, coord, vec4<f32>(existing.rgb + contribution, existing.a));
}
