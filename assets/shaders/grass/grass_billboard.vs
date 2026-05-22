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
// ---------------------------------------------------------------------------
// Shared grass shader declarations: GrassUniforms struct + Bayer dithering.
//  in any grass shader that needs LOD or wind.
// ---------------------------------------------------------------------------

struct GrassUniforms {
  windDir:          vec2<f32>,  // offset  0 — normalised XZ wind direction
  windSpeed:        f32,        // offset  8 — overall speed / amplitude scale
  wiggleIntensity:  f32,        // offset 12 — Phase 1: max chaotic XZ wiggle (m)
  wiggleFrequency:  f32,        // offset 16 — Phase 1: spatial frequency
  swayIntensity:    f32,        // offset 20 — Phase 2: max directional sway (m)
  swayFrequency:    f32,        // offset 24 — Phase 2: oscillation rate
  gustFrequency:    f32,        // offset 28 — Phase 3: spatial stripe frequency
  gustSpeed:        f32,        // offset 32 — Phase 3: stripe travel speed
  gustIntensity:    f32,        // offset 36 — Phase 3: amplitude multiplier at gust peak
  lodNearFadeStart: f32,        // offset 40 — distance where near LOD begins fading out
  lodNearFadeEnd:   f32,        // offset 44 — distance where near LOD is fully gone
  lodFarFadeStart:  f32,        // offset 48 — distance where billboard begins fading in
  lodFarFadeEnd:    f32,        // offset 52 — distance where billboard is fully gone
  // struct size 56 bytes, AlignOf 8 → GPU buffer allocated as 64 bytes
}

// ---------------------------------------------------------------------------
// Bayer 4×4 ordered-dithering threshold for distance-based LOD transitions.
// pos: screen-space pixel coordinates (input.position.xy in a fragment shader).
// Returns a value in [0, 1).
// Usage:  if fadeRatio > bayer4x4(pos) { discard; }
//   fadeRatio = 0  → never discard (fully visible)
//   fadeRatio = 1  → always discard (fully invisible)
// ---------------------------------------------------------------------------
fn bayer4x4(pos: vec2<f32>) -> f32 {
  let bayer = array<u32, 16>(
     0u,  8u,  2u, 10u,
    12u,  4u, 14u,  6u,
     3u, 11u,  1u,  9u,
    15u,  7u, 13u,  5u
  );
  let ix = u32(pos.x) % 4u;
  let iy = u32(pos.y) % 4u;
  return f32(bayer[ix + iy * 4u]) / 16.0;
}


// ---------------------------------------------------------------------------
// Grass billboard vertex shader — far LOD (cross-billboard, two quads in X).
//
// Uses the same GrassInstance storage buffer as grass_instanced.vs (@group 2)
// and the same GrassUniforms wind/LOD buffer (@group 3).
//
// Wind: only Phase 2 (slow directional sway) is applied — at 20–55 m individual
// blade wiggle is imperceptible, so the cheaper animation is sufficient.
//
// The cross-billboard mesh (grass_blade.gltf) has a fixed rotation baked at
// scatter time; no camera-facing needed because the X shape looks acceptable
// from all horizontal viewing angles.
//
// Camera distance from the instance root is packed into output.T.y so the
// fragment shader can perform Bayer-dithered fade-in and fade-out.
// ---------------------------------------------------------------------------
// @group(0) = CameraUniforms
// @group(1) = MaterialTextures  (FS only — not declared here)
// @group(2) = InstanceStorage   (array<GrassInstance>)
// @group(3) = GrassUniforms     (wind + LOD params, updated each frame)
// ---------------------------------------------------------------------------

struct GrassInstance {
  pos:      vec3<f32>,   // offset  0, size 12
  seed:     f32,         // offset 12
  rotation: f32,         // offset 16
  scale:    f32,         // offset 20
  zone:     f32,         // offset 24 — height-map zone [0,1]
  _pad:     f32,         // offset 28
}

@group(0) @binding(0) var<uniform>           camera:       CameraUniforms;
@group(2) @binding(0) var<storage, read>     instances:    array<GrassInstance>;
@group(3) @binding(0) var<uniform>           grassUniforms: GrassUniforms;

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,
  @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
  let inst = instances[instanceIdx];
  let t    = camera.time;
  let ws   = grassUniforms.windSpeed;

  // 1. Uniform scale
  let scaledPos = position * inst.scale;

  // 2. Y-axis rotation (baked at scatter time — orients the cross billboard)
  let cosR = cos(inst.rotation);
  let sinR = sin(inst.rotation);
  let rotatedPos = vec3<f32>(
    scaledPos.x * cosR - scaledPos.z * sinR,
    scaledPos.y,
    scaledPos.x * sinR + scaledPos.z * cosR,
  );

  // 3. Base world position
  let worldPos = inst.pos + rotatedPos;

  // Height factor (0 = root, 1 = tip).
  let h = 1.0 - uv.y;

  // ── Phase 2: Sway only ───────────────────────────────────────────────────
  // Slow directional bend along windDir.  Cheap enough for thousands of
  // billboard instances; the other phases are imperceptible at this distance.
  let spatialPhase = (worldPos.x + worldPos.z) * 0.04;
  let swayPhase    = t * grassUniforms.swayFrequency * ws + spatialPhase;
  let swayAmt      = sin(swayPhase) * grassUniforms.swayIntensity * h;
  let swayX        = grassUniforms.windDir.x * swayAmt;
  let swayZ        = grassUniforms.windDir.y * swayAmt;

  let animatedPos = vec3<f32>(
    worldPos.x + swayX,
    worldPos.y,
    worldPos.z + swayZ,
  );

  // Camera distance from instance root (passed to FS for LOD dithering).
  let camDist = length(inst.pos - camera.cameraPosition.xyz);

  var output: VertexOutput;
  output.WorldPos = animatedPos;
  output.position = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(animatedPos, 1.0);
  output.N  = normal;
  output.T  = vec4<f32>(1.0, camDist, inst.zone, inst.seed); // T.y=camDist, T.z=zone, T.w=seed
  output.Uv = uv;
  return output;
}
