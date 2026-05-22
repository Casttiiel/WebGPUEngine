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
fn sign_nonzero_f(v: f32) -> f32 {
    return select(-1.0, 1.0, v >= 0.0);
}



fn encodeOctahedral(n: vec3<f32>) -> vec2<f32> {
    // Proyección octahedral: divide por la norma L1
    var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    // Wrap para hemisferio negativo Z
    if (n.z < 0.0) {
        p = (1.0 - abs(p.yx)) * sign_nonzero(p);
    }
    return p;  // rango [-1, 1]
}

fn decodeOctahedral(p: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    if (n.z < 0.0) {
        let tmp = n.xy;
        n.x = (1.0 - abs(tmp.y)) * sign_nonzero_f(tmp.x);
        n.y = (1.0 - abs(tmp.x)) * sign_nonzero_f(tmp.y);
    }
    return normalize(n);
}

// sign que devuelve +1 cuando x=0 (necesario para el wrap)
fn sign_nonzero(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0)
    );
}

fn normalToOctahedral01(n: vec3<f32>) -> vec2<f32> {
    return encodeOctahedral(n) * 0.5 + 0.5;
}

fn octahedral01ToNormal(enc: vec2<f32>) -> vec3<f32> {
    return decodeOctahedral(enc * 2.0 - 1.0);
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
// Grass blade fragment shader — UV-based two-colour gradient, GBuffer output.
//
// MaterialFactors fields are repurposed for the gradient:
//   baseColorFactor.rgb  = colorBottom  colour at UV.y = 0
//   roughnessFactor      = colorTop.r   }
//   metallicFactor       = colorTop.g   }  colour at UV.y = 1
//   emissiveFactor       = colorTop.b   }
//   appearanceBlend      = blendStart   UV.y <= this  → 100 % colorBottom
//   surfaceBlend         = blendEnd     UV.y >= this  → 100 % colorTop
//
// All colour values are in linear space.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform>  camera:       CameraUniforms;
@group(1) @binding(0) var           txAlbedo:     texture_2d<f32>;
@group(1) @binding(5) var           samplerState: sampler;
@group(1) @binding(6) var<uniform>  factors:      MaterialFactors;
@group(3) @binding(0) var<uniform>  grassUniforms: GrassUniforms;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
  let uv = input.Uv;

  // ── UV gradient ──────────────────────────────────────────────────────────
  let colorBottom = factors.baseColorFactor.rgb;
  let colorTop    = vec3<f32>(factors.roughnessFactor, factors.metallicFactor, factors.emissiveFactor);
  // smoothstep: 0.0 below blendStart, 1.0 above blendEnd, smooth S-curve between.
  let t              = smoothstep(factors.appearanceBlend, factors.surfaceBlend, uv.y);
  let gradientAlbedo = mix(colorBottom, colorTop, t);

  // ── Zone colour tint ──────────────────────────────────────────────────────
  // Tall zones (zone → 1) blend toward colorTall (stored in repurposed material
  // fields uvXScale / uvYScale / pomScale).  Threshold: starts at zone 0.4.
  // When no heightMap is used all blades have zone = 0, so this is a no-op.
  let colorTall = vec3<f32>(factors.uvXScale, factors.uvYScale, factors.pomScale);
  let zone      = input.T.z;
  let albedo    = mix(gradientAlbedo, colorTall, smoothstep(0.4, 1.0, zone));

  // ── Normal ────────────────────────────────────────────────────────────────
  // Blend the geometric normal toward world-up so that SSAO treats the grass
  // like a smooth hill surface instead of a vertical plane (avoids dark halos).
  // Technique mirrors Unreal Engine's grass shading.
  let N           = normalize(input.N);
  let bentN       = normalize(mix(N, vec3<f32>(0.0, 1.0, 0.0), 0.8));
  let encodedNorm = normalToOctahedral01(bentN);

  let roughness = 0.85;
  let metallic  = 0.0;
  let emissive  = 0.0;

  // ── Linear depth ──────────────────────────────────────────────────────────
  let camToWorld  = input.WorldPos - camera.cameraPosition.xyz;
  let linearDepth = dot(camToWorld, camera.cameraFront.xyz) / camera.cameraFar;

  var output: FragmentOutput;
  output.albedo = vec4<f32>(albedo, metallic);
  output.normal = vec4<f32>(encodedNorm.x, encodedNorm.y, roughness, emissive);
  output.depth  = linearDepth;

  // ── Near LOD distance fade (Bayer 4×4 dithering) ————————————————————
  // T.y carries the camera distance from the instance root (set in grass_instanced.vs).
  let camDist = input.T.y;
  if camDist >= grassUniforms.lodNearFadeEnd {
    discard;
  }
  if camDist > grassUniforms.lodNearFadeStart {
    // Fade ratio: 0 at fadeStart (fully visible) → 1 at fadeEnd (fully invisible)
    let fadeRatio = (camDist - grassUniforms.lodNearFadeStart)
                  / (grassUniforms.lodNearFadeEnd - grassUniforms.lodNearFadeStart);
    if fadeRatio > bayer4x4(input.position.xy) {
      discard;
    }
  }

  return output;
}
