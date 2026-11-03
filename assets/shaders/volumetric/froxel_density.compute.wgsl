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

// Bind groups
@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricParams: VolumetricUniforms;

// Output 3D texture (R32F - single channel density)
@group(2) @binding(0) var froxelDensityTexture: texture_storage_3d<rg32float, write>;

@group(3) @binding(0) var noiseTex: texture_2d<f32>;
@group(3) @binding(1) var noiseSampler: sampler;
@group(3) @binding(2) var linearDepth: texture_2d<f32>;
@group(3) @binding(3) var<uniform> fogVolumeData: FogVolumeData;

// Triplanar sample of the RGB tileable noise texture at a given world position and scale.
// Uses the 3 channels for independent variation across projections.
fn triplanarNoise(worldPos: vec3<f32>, scale: f32, windOffset: vec3<f32>) -> f32 {
    let p    = (worldPos + windOffset) * scale;
    let dims = vec2<f32>(textureDimensions(noiseTex));

    let uv1 = fract(p.xy); let uv2 = fract(p.yz); let uv3 = fract(p.zx);

    // Each projection uses a different channel so they blend independently
    let c1 = textureLoad(noiseTex, vec2<i32>(uv1 * dims), 0).r;  // XY → R
    let c2 = textureLoad(noiseTex, vec2<i32>(uv2 * dims), 0).g;  // YZ → G
    let c3 = textureLoad(noiseTex, vec2<i32>(uv3 * dims), 0).b;  // ZX → B
    return (c1 + c2 + c3) * 0.3333;
}

// FBM: 3 octaves of triplanar noise with wind advection per octave.
// Slower-moving large scales + faster-moving small details = turbulent wisps.
// windDir.xz = Wind singleton direction×speed (world units/s, XZ plane only).
// windDir.y is repurposed for cameraFar — never use it as wind.
fn sampleNoise3D(worldPos: vec3<f32>) -> f32 {
    // Horizontal wind only (Y=0 keeps fog layer from drifting vertically)
    let wind = vec3<f32>(volumetricParams.windDir.x, 0.0, volumetricParams.windDir.z) * camera.time;

    // Octave 1 – large base shape (slow)
    let n1 = triplanarNoise(worldPos, 0.012, wind * 1.0);
    // Octave 2 – medium detail (medium speed)
    let n2 = triplanarNoise(worldPos, 0.030, wind * 1.7);
    // Octave 3 – fine wisps (fast)
    let n3 = triplanarNoise(worldPos, 0.075, wind * 2.8);

    // FBM weights: 1 + 0.5 + 0.25 = 1.75
    return (n1 + n2 * 0.5 + n3 * 0.25) / 1.75;
}

// -----------------------------------------------------------------------
// Ruido 3D procedural de los volúmenes (bruma irregular, sin textura: no se repite)
// -----------------------------------------------------------------------

fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.x + q.y) * q.z);
}

/// Value noise 3D con interpolación quíntica (sin escalones), en [0, 1].
fn valueNoise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let a = hash31(i);
    let b = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
    let c = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
    let d = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
    let e = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
    let g = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
    let h = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
    let k = hash31(i + vec3<f32>(1.0, 1.0, 1.0));
    return mix(
        mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
        mix(mix(e, g, u.x), mix(h, k, u.x), u.y),
        u.z,
    );
}

/// FBM de `octaves` octavas (cada una al doble de frecuencia y la mitad de peso), en [0, 1].
fn fbm3(p: vec3<f32>, octaves: i32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    var q = p;
    for (var o = 0; o < octaves; o++) {
        sum += valueNoise3(q) * amp;
        norm += amp;
        // Rotación entre octavas para que no se alineen con los ejes.
        q = vec3<f32>(q.x * 1.6 + q.z * 1.2, q.y * 2.0, -q.x * 1.2 + q.z * 1.6) + vec3<f32>(17.1, 3.7, 9.3);
        amp *= 0.5;
    }
    return sum / norm;
}

/// Densidad relativa de la bruma en `worldPos` para un volumen con ruido `noise`
/// (x=amount, y=scale, z=speed, w=edgeBreakup). Devuelve el valor FBM en [0, 1].
fn mistNoise(worldPos: vec3<f32>, noise: vec4<f32>) -> f32 {
    let t = camera.time;
    // Deriva: un poco del viento del motor (XZ; pensado para nubes, aquí sería un vendaval)
    // más una corriente propia lenta.
    let wind = vec3<f32>(volumetricParams.windDir.x, 0.0, volumetricParams.windDir.z) * 0.25;
    let drift = (wind + vec3<f32>(0.8, 0.0, 0.5) * noise.z) * t;
    // Más ancha que alta: bancos y jirones tendidos, no bolas.
    var q = (worldPos - drift) * noise.y * vec3<f32>(1.0, 1.8, 1.0);
    // La forma evoluciona (no solo se desplaza).
    q.y += t * noise.z * 0.15;
    // Domain warping: deforma el espacio con otro ruido → remolinos y jirones.
    let warp = vec3<f32>(
        fbm3(q * 0.5 + vec3<f32>(1.7, 9.2, 4.3), 2),
        fbm3(q * 0.5 + vec3<f32>(8.3, 2.8, 6.1), 2),
        fbm3(q * 0.5 + vec3<f32>(3.1, 5.7, 7.3), 2),
    ) - 0.5;
    return fbm3(q + warp * 2.2, 4);
}

// -----------------------------------------------------------------------
// Fog Volume SDF helpers
// -----------------------------------------------------------------------

/// Signed distance to an axis-aligned box centered at the origin.
fn sdfBox(p: vec3<f32>, halfExtents: vec3<f32>) -> f32 {
    let d = abs(p) - halfExtents;
    return length(max(d, vec3<f32>(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
}

/// Signed distance to a sphere centered at the origin.
fn sdfSphere(p: vec3<f32>, radius: f32) -> f32 {
    return length(p) - radius;
}

/// Applies all active fog volumes on top of the base sigmaS / sigmaT values.
/// Returns vec2(finalSigmaS, finalSigmaT).
fn applyFogVolumes(worldPos: vec3<f32>, baseSigmaS: f32, baseSigmaT: f32) -> vec2<f32> {
    var outS = baseSigmaS;
    var outT = baseSigmaT;

    for (var i = 0u; i < fogVolumeData.count; i++) {
        let vol = fogVolumeData.volumes[i];

        // Signed distance from froxel world position to volume surface
        let localPos = worldPos - vol.center;
        var sdf: f32;
        if (vol.shape < 0.5) {
            // Sphere — halfExtents.x stores the radius
            sdf = sdfSphere(localPos, vol.halfExtents.x);
        } else {
            // Box
            sdf = sdfBox(localPos, vol.halfExtents);
        }

        // Ruido del volumen (solo cerca o dentro de él).
        let hasNoise = vol.noise.x > 0.0 || vol.noise.w > 0.0;
        var n = 0.5;
        if (hasNoise && sdf < vol.falloff + vol.halfExtents.y * vol.noise.w) {
            n = mistNoise(worldPos, vol.noise);
            // Borde irregular: la superficie sube y baja con el ruido (cimas y valles).
            sdf += (0.5 - n) * 2.0 * vol.noise.w * vol.halfExtents.y;
        }

        // blend = 1 inside, smoothly falls to 0 over [0, falloff] outside the surface
        var blend = saturate(smoothstep(0.0, vol.falloff, -sdf));
        // Jirones: huecos más finos donde el ruido es bajo (nunca vacíos del todo) y bancos
        // densos donde es alto.
        if (blend > 0.0 && vol.noise.x > 0.0) {
            let patches = mix(0.35, 1.75, smoothstep(0.32, 0.72, n));
            blend *= mix(1.0, patches, vol.noise.x);
        }

        if (blend > 0.0) {
            if (vol.blendMode < 0.5) {
                // "add" — accumulate density on top of the global fog
                outS += vol.sigmaS * blend;
                outT += vol.sigmaT * blend;
            } else {
                // "override" — lerp toward the volume's density (clears fog in interiors)
                outS = mix(outS, vol.sigmaS, saturate(blend));
                outT = mix(outT, vol.sigmaT, saturate(blend));
            }
        }
    }

    return vec2<f32>(outS, outT);
}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let froxelCoord = globalId.xyz;
  
  // Bounds check
  if (froxelCoord.x >= u32(froxelParams.dimensions.x) ||
    froxelCoord.y >= u32(froxelParams.dimensions.y) ||
    froxelCoord.z >= u32(froxelParams.dimensions.z)) {
    return;
  }

  // Density is evaluated at the froxel centre (low-frequency field, not jittered).
  let froxelVS = froxelCoordToViewSpace(
    vec3<f32>(globalId) + vec3<f32>(0.5),
    froxelParams.dimensions.xyz,
    froxelParams.depthDistScale,
    froxelParams.depthDistB,
    camera.invProjection
  );
  let tempFroxelWS = (camera.invView * vec4<f32>(froxelVS, 1.0));
  let froxelWS = tempFroxelWS.xyz / tempFroxelWS.w;


  // 2) Height fog (parameters from uniform)
  let fogBaseHeight = volumetricParams.fogBaseHeight;
  let fogLayerHeight = volumetricParams.fogLayerHeight;
  let fogFalloff = volumetricParams.fogFalloff;

  let h = froxelWS.y - fogBaseHeight;

  // Altura normalizada dentro de la capa
  let layerT = saturate(h / fogLayerHeight);

  // Capa más densa abajo
  let layerShape = smoothstep(0.0, 1.0, 1.0 - layerT);

  // Decay arriba
  let above = max(h - fogLayerHeight, 0.0);
  let expFalloff = exp(-above * fogFalloff);

  let heightFog = layerShape * expFalloff;

  // Base density
  var densityFinal = volumetricParams.fogDensity * heightFog;

  // 3D Noise
  let noise = sampleNoise3D(froxelWS);

  // Más noise abajo
  let heightMask = saturate(1.0 - layerT);
  let layeredNoise = mix(1.0, noise, heightMask);

  // Mucho más contraste para shafts
  let shapedNoise = smoothstep(0.2, 0.8, layeredNoise);
  let noiseFactor = mix(0.5, 1.8, shapedNoise);

  densityFinal *= noiseFactor;

  // parámetros globales físicos
  let sigmaS = densityFinal * volumetricParams.scatteringCoeff;
  let sigmaA = densityFinal * volumetricParams.absorptionCoeff;
  let sigmaT = sigmaS + sigmaA;

  // Apply world-space density volumes (SDF blend)
  let finalParams = applyFogVolumes(froxelWS, sigmaS, sigmaT);

  // Store density in 3D texture (rg32float: R=sigmaS, G=sigmaT)
  textureStore(froxelDensityTexture, froxelCoord, vec4<f32>(finalParams.x, finalParams.y, 0.0, 0.0));
}
