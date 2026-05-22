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



@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;
@group(0) @binding(2) var froxelIntegratedTexture: texture_3d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var blueNoiseTex: texture_2d<f32>;
@group(0) @binding(5) var nearestSampler: sampler;

// G-Buffer depth for proper ray termination
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;


fn depth01ToViewZ(depth01: f32) -> f32 {
  // cameraFar is packed into volumetricSettings.windDir.y by FroxelVolumetricScattering.ts
  return depth01 * volumetricSettings.windDir.y;
}

fn viewZToFroxelZLog(viewZ: f32, nearZ: f32, farZ: f32) -> f32 {
  let z = clamp(viewZ, nearZ, farZ);
  return log(z / nearZ) / log(farZ / nearZ);
}

fn depth01ToFroxelZ(depth01: f32) -> f32 {
  let viewZ = depth01ToViewZ(depth01);
  return viewZToFroxelZLog(viewZ, froxelParams.nearPlane, froxelParams.farPlane);
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dimsF = froxelParams.dimensions.xyz;

  let fx = clamp(uv.x * dimsF.x, 0.0, dimsF.x - 1.0);
  let fy = clamp(uv.y * dimsF.y, 0.0, dimsF.y - 1.0);

  // Animate blue noise offset with golden-ratio frame progression so TAA
  // can average out the dithering pattern across frames.
  let frameTime   = volumetricSettings.windDir.w;           // camera.time packed into unused w component
  let frameOffset = fract(frameTime * 0.61803398874);       // golden ratio per-frame shift
  let noiseUV = fract(uv * vec2<f32>(volumetricSettings.renderWidth, volumetricSettings.renderHeight) / 64.0 + frameOffset);
  let dither = textureSample(blueNoiseTex, nearestSampler, noiseUV).r - 0.5;

  // Dither in froxel Z-space (±0.5 froxels) so each pair of adjacent frames
  // samples on opposite sides of a slice boundary.  TAA then averages them,
  // eliminating the visible step between slices.
  // We also clamp the final fz to scene depth so we never leak fog from
  // behind geometry.
  let depth01 = textureSample(gLinearDepth, samplerGBuffer, uv).x;
  let viewZ   = depth01ToViewZ(depth01);
  let z01     = viewZToFroxelZLog(viewZ, froxelParams.nearPlane, froxelParams.farPlane);
  // ±0.5 froxel dither — spans exactly one slice at any depth
  let fzScene = z01 * dimsF.z;

  // Cap the Z lookup to floor(fzScene): the last froxel slice whose texel
  // centre sits strictly in front of the GBuffer surface.
  //
  // Why floor and not fzScene directly?
  //   textureSampleLevel maps fz → uvw.z = (fz + 0.5) / numSlices.
  //   Trilinear then blends between floor(uvw.z * N - 0.5) and ceil() texels.
  //   When fz = K (integer), uvw.z lands exactly on texel K's centre → zero
  //   blending with texel K+1 (the wall slice).
  //   When fz = K + ε, the GPU starts pulling in texel K+1 → leak.
  //   Capping at floor(fzScene) ensures fz ≤ K so the ceil texel is always
  //   K or less — never the slice that straddles the geometry boundary.
  let fzMax = floor(fzScene);
  let fz    = clamp(fzScene + dither, 0.0, fzMax);  // never reach the wall slice

  // Dither XY
  let ditherX = dither * 0.5;
  let ditherY = (fract(dither + 0.5) - 0.5) * 0.5;

  let uvw = (vec3<f32>(fx + ditherX, fy + ditherY, fz) + vec3<f32>(0.5)) / dimsF;

  let integrated = textureSampleLevel(froxelIntegratedTexture, linearSampler, uvw, 0.0);

  return vec4<f32>(integrated.rgb, integrated.a);
}