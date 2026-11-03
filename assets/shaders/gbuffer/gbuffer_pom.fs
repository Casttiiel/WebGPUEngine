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
// Matrix utility functions
// Level 1: No dependencies

// Extract 3x3 rotation/scale from 4x4 transformation matrix
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

// Compute TBN (Tangent-Bitangent-Normal) matrix for normal mapping
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
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
// Shared by gbuffer_pom.vs / gbuffer_pom.fs.

struct POMVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    // Object box (unit cube × model matrix): world centre, unit axes, half extents in metres.
    @location(4) @interpolate(flat) BoxCenter: vec3<f32>,
    @location(5) @interpolate(flat) BoxAxisX: vec3<f32>,
    @location(6) @interpolate(flat) BoxAxisY: vec3<f32>,
    @location(7) @interpolate(flat) BoxAxisZ: vec3<f32>,
    @location(8) @interpolate(flat) BoxHalf: vec3<f32>,
}

// MaterialFactors + the extras block at offset 48 (renderer/resources/MaterialExtras.ts:
// same order, vec3s unpacked as three floats so nothing gets padded).
struct PomFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,
    pomScale: f32,
    // extras
    pomShadow: f32,
    layerCoverage: f32,
    layerNoiseScale: f32,
    layerSharpness: f32,
    layerUvScale: f32,
    antiTileScale: f32,
    cavityDirt: f32,
    baseDirtHeight: f32,
    dirtColorR: f32,
    dirtColorG: f32,
    dirtColorB: f32,
    baseDirtStrength: f32,
    layerTintR: f32,
    layerTintG: f32,
    layerTintB: f32,
    layerHeightOffset: f32,
    ashAmount: f32,
    ashNoiseScale: f32,
    ashSharpness: f32,
    ashColorR: f32,
    ashColorG: f32,
    ashColorB: f32,
    _extrasPad0: f32,
    _extrasPad1: f32,
}


// ─── Parallax Occlusion Mapping (G-buffer) — the solid "master" surface ──────
//
// Permutations (material "features"):
//   (none)      Mesh UVs + mesh TBN. pomScale = relief depth in UV units.
//   BOX         Axis-aligned box faces (unit cube × model matrix): texture coordinates
//               are the world position projected on the face axes × uvXScale (tiles per
//               metre, like triplanar_world, but following the box when it rotates).
//               pomScale = relief depth in metres.
//   SILHOUETTE  (needs BOX) a view ray that leaves the box before hitting the relief is
//               discarded, so the relief also cuts the object's outline. The technique
//               variant skips the depth prepass and writes depth itself (a prepass
//               without the discard would leave holes).
//   POM_SHADOW  Soft self-shadow toward the sun, marched in the height field. Deferred
//               lighting can't take it, so it darkens the albedo (pomShadow = strength).
//   LAYER       Height blending: a second material (tx*2 slots) laid over the base where
//               a world-space noise mask says so. The two heights are compared, so the
//               base's high parts break through first (bricks through plaster) and the
//               layer stays in the low ones (dirt between cobbles). The relief follows
//               the blended height.
//   ANTI_TILE   Breaks the repetition of the base textures: two copies with random
//               offsets, switched by a low-frequency noise (Quílez, "texture repetition"),
//               the transition following the height so it reads as part of the surface.
//   DIRT        Grime: cavityDirt in the low parts of the relief, and (BOX) a noisy band
//               baseDirtHeight metres high at the bottom of the box's sides.
//   ASH         Ash settled on whatever faces up: a per-pixel ash level (ashAmount × how
//               horizontal the face is × drift noise) fills the relief from the bottom —
//               joints and cracks first, the whole top buried when it's deep — and the
//               POM marches the filled surface, so the ash is flat where it lies.
//
// Height maps: R, 1 = surface (the mesh), 0 = deepest. The relief is carved INTO the
// mesh, so the geometric depth written below is the top of the relief.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var txHeight:    texture_2d<f32>;
@group(1) @binding(6) var samplerState: sampler;
@group(1) @binding(7) var<uniform> factors: PomFactors;
#ifdef LAYER
@group(1) @binding(8)  var txAlbedo2:    texture_2d<f32>;
@group(1) @binding(9)  var txNormal2:    texture_2d<f32>;
@group(1) @binding(10) var txRoughness2: texture_2d<f32>;
@group(1) @binding(11) var txHeight2:    texture_2d<f32>;
#endif

const MIN_STEPS    = 6.0;
const MAX_STEPS    = 48.0;
const SHADOW_STEPS = 12;
// Steepest view the march extrapolates (cos ≈ 0.1 → 84°): beyond it the ray length explodes.
const MIN_VIEW_COS = 0.1;

// Per-pixel state shared by the height lookups of the march (set once in fs()).
var<private> gTileOffA:   vec2<f32>; // ANTI_TILE: offsets of the two copies…
var<private> gTileOffB:   vec2<f32>;
var<private> gTileBlend:  f32;       // …and how much of B
var<private> gLayerRatio: f32;       // LAYER: layer uv = base uv × ratio
var<private> gLayerLod:   f32;       // layer mip − base mip
var<private> gLayerBias:  f32;       // mask: added to the layer's height
var<private> gAshLevel:   f32;       // ASH: height the ash fills the relief up to (≤ 0: none)

// Texture-space frame of the shaded point.
struct Surface {
    uv:    vec2<f32>,  // base texture coordinates
    dirU:  vec3<f32>,  // world direction of +u
    dirV:  vec3<f32>,  // world direction of +v
    mapT:  vec3<f32>,  // world direction of the normal map's +X
    mapB:  vec3<f32>,  // world direction of the normal map's +Y
    N:     vec3<f32>,  // outward surface normal
    scale: f32,        // uv units per unit of pomScale (1 for mesh UVs, uvXScale for BOX)
    duvdx: vec2<f32>,
    duvdy: vec2<f32>,
}

fn meshSurface(input: POMVertexOutput) -> Surface {
    var s: Surface;
    let TBN = computeTBN(normalize(input.N), input.T);
    s.uv    = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    s.dirU  = TBN[0];
    s.dirV  = TBN[1];
    s.mapT  = TBN[0];
    s.mapB  = TBN[1];
    s.N     = TBN[2];
    s.scale = 1.0;
    return s;
}

fn boxSurface(input: POMVertexOutput) -> Surface {
    var s: Surface;
    let n = normalize(input.N);
    let l = vec3<f32>(dot(n, input.BoxAxisX), dot(n, input.BoxAxisY), dot(n, input.BoxAxisZ));
    let a = abs(l);
    // Face = dominant box axis of the normal. "up" is the image's up on that face.
    var N  = input.BoxAxisZ * sign(l.z);
    var up = input.BoxAxisY;
    if (a.y >= a.x && a.y >= a.z) {
        N  = input.BoxAxisY * sign(l.y);
        up = -input.BoxAxisZ * sign(l.y);
    } else if (a.x >= a.z) {
        N  = input.BoxAxisX * sign(l.x);
    }
    let T = cross(up, N); // image right, seen from outside
    s.scale = factors.uvXScale;
    s.uv    = vec2<f32>(dot(input.WorldPos, T), -dot(input.WorldPos, up)) * s.scale;
    s.dirU  = T;
    s.dirV  = -up;
    s.mapT  = T;
    s.mapB  = up;   // *_nor_gl maps: green = image up
    s.N     = N;
    return s;
}

// ── Noise ────────────────────────────────────────────────────────────────────
fn hash21(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
    return fract(sin(vec2<f32>(dot(p, vec2<f32>(127.1, 311.7)), dot(p, vec2<f32>(269.5, 183.3)))) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

fn hash31(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(mix(hash31(i), hash31(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
                mix(hash31(i + vec3<f32>(0.0, 1.0, 0.0)), hash31(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y);
    let b = mix(mix(hash31(i + vec3<f32>(0.0, 0.0, 1.0)), hash31(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
                mix(hash31(i + vec3<f32>(0.0, 1.0, 1.0)), hash31(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y);
    return mix(a, b, u.z);
}

fn fbm3(p: vec3<f32>) -> f32 {
    return noise3(p) * 0.55 + noise3(p * 2.03 + 13.1) * 0.3 + noise3(p * 4.11 + 41.7) * 0.15;
}

// ── Height field (base, anti-tiling, layer) ──────────────────────────────────
// ANTI_TILE: most pixels lie wholly in one copy (gTileBlend exactly 0 or 1) and only the
// seams need both. The blend comes from a low-frequency noise, so neighbouring pixels take
// the same branch; fetching both copies everywhere cost ~1.8 ms of G-buffer at 4K.
fn baseHeightAt(uv: vec2<f32>, lod: f32) -> f32 {
#ifdef ANTI_TILE
    if (gTileBlend <= 0.0) { return textureSampleLevel(txHeight, samplerState, uv + gTileOffA, lod).r; }
    if (gTileBlend >= 1.0) { return textureSampleLevel(txHeight, samplerState, uv + gTileOffB, lod).r; }
    let a = textureSampleLevel(txHeight, samplerState, uv + gTileOffA, lod).r;
    let b = textureSampleLevel(txHeight, samplerState, uv + gTileOffB, lod).r;
    return mix(a, b, gTileBlend);
#else
    return textureSampleLevel(txHeight, samplerState, uv, lod).r;
#endif
}

// The march and the relief shadow read the layer's height one mip coarser: the layer
// (dirt, plaster) is low-frequency next to the base, and its fetch every step was
// ~1.3 ms of G-buffer at 4K. The final shading keeps the full mip.
const LAYER_MARCH_LOD_BIAS = 1.0;

// x = blended height, y = layer weight. layerLodBias: extra mips for the layer height.
fn surfaceHeight(uv: vec2<f32>, lod: f32, layerLodBias: f32) -> vec2<f32> {
    let hb = baseHeightAt(uv, lod);
#ifdef LAYER
    let raw = textureSampleLevel(txHeight2, samplerState, uv * gLayerRatio, lod + gLayerLod + layerLodBias).r;
    let hl  = saturate(raw + factors.layerHeightOffset + gLayerBias);
    let s   = max(factors.layerSharpness, 1e-3);
    let w   = smoothstep(-s, s, hl - hb);
    return vec2<f32>(mix(hb, hl, w), w);
#else
    return vec2<f32>(hb, 0.0);
#endif
}

fn heightAt(uv: vec2<f32>, lod: f32) -> f32 {
#ifdef ASH
    return max(surfaceHeight(uv, lod, LAYER_MARCH_LOD_BIAS).x, min(gAshLevel, 1.0));
#else
    return surfaceHeight(uv, lod, LAYER_MARCH_LOD_BIAS).x;
#endif
}

fn sampleBase(tex: texture_2d<f32>, uv: vec2<f32>, gx: vec2<f32>, gy: vec2<f32>) -> vec4<f32> {
#ifdef ANTI_TILE
    if (gTileBlend <= 0.0) { return textureSampleGrad(tex, samplerState, uv + gTileOffA, gx, gy); }
    if (gTileBlend >= 1.0) { return textureSampleGrad(tex, samplerState, uv + gTileOffB, gx, gy); }
    let a = textureSampleGrad(tex, samplerState, uv + gTileOffA, gx, gy);
    let b = textureSampleGrad(tex, samplerState, uv + gTileOffB, gx, gy);
    return mix(a, b, gTileBlend);
#else
    return textureSampleGrad(tex, samplerState, uv, gx, gy);
#endif
}

fn insideBox(input: POMVertexOutput, p: vec3<f32>) -> bool {
    let d = p - input.BoxCenter;
    let local = abs(vec3<f32>(dot(d, input.BoxAxisX), dot(d, input.BoxAxisY), dot(d, input.BoxAxisZ)));
    return all(local <= input.BoxHalf + vec3<f32>(1e-4));
}

struct MarchHit {
    uv:     vec2<f32>,
    depth:  f32,   // fraction of the relief depth (0 = surface, 1 = deepest)
    exited: bool,  // the ray left the box before hitting (SILHOUETTE)
}

// Steps down from the surface (depth 0) to the deepest layer (1); uvRay / worldRay are
// the texture / world offsets of the view ray at depth 1. Linear refinement at the end.
fn march(input: POMVertexOutput, uv0: vec2<f32>, uvRay: vec2<f32>, worldRay: vec3<f32>,
         steps: f32, lod: f32) -> MarchHit {
    var hit: MarchHit;
    hit.exited = false;
    let n = i32(steps);
    let layer = 1.0 / steps;

    var prevDepth   = 0.0;
    var prevSurface = 1.0 - heightAt(uv0, lod);
    var depth   = 0.0;
    var surface = prevSurface;
    if (surface <= 0.0) {
        hit.uv = uv0;
        hit.depth = 0.0;
        return hit;
    }
    for (var i = 0; i < n; i++) {
        prevDepth   = depth;
        prevSurface = surface;
        depth += layer;
#ifdef SILHOUETTE
        if (!insideBox(input, input.WorldPos + worldRay * depth)) {
            hit.exited = true;
            break;
        }
#endif
        surface = 1.0 - heightAt(uv0 + uvRay * depth, lod);
        if (depth >= surface) {
            break;
        }
    }
    // Intersection of the ray with the segment between the last two samples.
    let before = prevSurface - prevDepth; // > 0: ray still above the relief
    let after  = depth - surface;         // >= 0: ray below
    let t = select(0.0, before / max(before + after, 1e-5), before + after > 0.0);
    hit.depth = mix(prevDepth, depth, t);
    hit.uv    = uv0 + uvRay * hit.depth;
    return hit;
}

// 1 = lit, 0 = fully shadowed by the relief between the hit and the sun.
fn reliefShadow(hit: MarchHit, sunUvRay: vec2<f32>, lod: f32) -> f32 {
    if (hit.depth <= 0.0) { return 1.0; }
    var occlusion = 0.0;
    for (var i = 1; i <= SHADOW_STEPS; i++) {
        let f = f32(i) / f32(SHADOW_STEPS);
        let rayDepth = hit.depth * (1.0 - f);
        let surface  = 1.0 - heightAt(hit.uv + sunUvRay * (hit.depth - rayDepth), lod);
        // Relief above the ray, weighted down with distance → soft penumbra.
        occlusion = max(occlusion, (rayDepth - surface) * (1.0 - f));
    }
    return 1.0 - saturate(occlusion * 12.0);
}

@fragment
fn fs(input: POMVertexOutput) -> FragmentOutput {
    // Derivatives first, in uniform control flow.
    let dPdx = dpdx(input.WorldPos);
    let dPdy = dpdy(input.WorldPos);
    let dUvdx = dpdx(input.Uv);
    let dUvdy = dpdy(input.Uv);

#ifdef BOX
    var surf = boxSurface(input);
    // From the position derivatives, not dpdx(uv): uv jumps where two faces share a quad.
    surf.duvdx = vec2<f32>(dot(dPdx, surf.dirU), dot(dPdx, surf.dirV)) * surf.scale;
    surf.duvdy = vec2<f32>(dot(dPdy, surf.dirU), dot(dPdy, surf.dirV)) * surf.scale;
#else
    var surf = meshSurface(input);
    surf.duvdx = dUvdx * vec2<f32>(factors.uvXScale, factors.uvYScale);
    surf.duvdy = dUvdy * vec2<f32>(factors.uvXScale, factors.uvYScale);
#endif

    // ── LOD: height mip and how many pixels the relief spans there ────────────
    let heightSize = vec2<f32>(textureDimensions(txHeight, 0));
    let footprint  = max(length(surf.duvdx * heightSize), length(surf.duvdy * heightSize));
    let lod        = max(log2(max(footprint, 1e-6)) + camera.mipBias, 0.0);
    let texelsPerUv = heightSize.x * exp2(-lod);

    // ── Per-pixel variation state ─────────────────────────────────────────────
    gTileOffA = vec2<f32>(0.0);
    gTileOffB = vec2<f32>(0.0);
    gTileBlend = 0.0;
#ifdef ANTI_TILE
    {
        let k  = noise2(surf.uv * factors.antiTileScale) * 8.0;
        let ia = floor(k);
        gTileOffA = hash22(vec2<f32>(ia, 3.7));
        gTileOffB = hash22(vec2<f32>(ia + 1.0, 3.7));
        // Switch where the two copies' heights cross, not along a straight noise line.
        let ha = textureSampleLevel(txHeight, samplerState, surf.uv + gTileOffA, lod).r;
        let hb = textureSampleLevel(txHeight, samplerState, surf.uv + gTileOffB, lod).r;
        gTileBlend = smoothstep(0.3, 0.7, fract(k) + (hb - ha) * 0.6);
    }
#endif
    gLayerRatio = 1.0;
    gLayerLod   = 0.0;
    gLayerBias  = 0.0;
#ifdef LAYER
    {
        gLayerRatio = select(1.0, factors.layerUvScale / max(factors.uvXScale, 1e-4), factors.layerUvScale > 0.0);
        let layerSize = vec2<f32>(textureDimensions(txHeight2, 0));
        gLayerLod = log2(max(gLayerRatio * layerSize.x / heightSize.x, 1e-4));
        // World-space mask (continuous across faces and objects): coverage 0 → no layer,
        // 1 → layer everywhere, 0.5 → decided by the two heights alone where the noise is 0.5.
        let m = fbm3(input.WorldPos * factors.layerNoiseScale);
        gLayerBias = (m - (1.0 - factors.layerCoverage)) * 2.0;
    }
#endif

    gAshLevel = 0.0;
#ifdef ASH
    {
        // Only what faces up holds ash; drifts vary it across the world.
        let upness = smoothstep(0.3, 0.9, surf.N.y);
        let drift  = 0.55 + 0.9 * fbm3(input.WorldPos * factors.ashNoiseScale);
        // Above 1 the drift buries the surface completely (the relief keeps max 1).
        gAshLevel  = clamp(factors.ashAmount * upness * drift, 0.0, 1.3);
    }
#endif

    // Relief thinner than ~half a pixel is invisible: fade the depth (not the uv), skip.
    let reliefPx = factors.pomScale * surf.scale * texelsPerUv;
    let depthScale = factors.pomScale * smoothstep(0.35, 1.5, reliefPx);

    let V  = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let vz = max(dot(V, surf.N), MIN_VIEW_COS);

    var uvFinal  = surf.uv;
    var hitDepth = 0.0;
    var shadow   = 1.0;
    if (depthScale > 0.0) {
        let uvRay    = -vec2<f32>(dot(V, surf.dirU), dot(V, surf.dirV)) / vz * depthScale * surf.scale;
        let worldRay = -V / vz * depthScale;
        let pxTravel = length(uvRay) * texelsPerUv;
        // 0.5 steps per texel of travel: the linear refinement at the end covers the rest,
        // and at 4K 0.75 marched more steps than the relief can show.
        let steps    = clamp(max(pxTravel, reliefPx) * 0.5 + MIN_STEPS, MIN_STEPS, MAX_STEPS);

        let hit = march(input, surf.uv, uvRay, worldRay, steps, lod);
        if (hit.exited) {
            discard;
        }
        uvFinal  = hit.uv;
        hitDepth = hit.depth * depthScale;

#ifdef POM_SHADOW
        let S  = camera.sunDirection.xyz;
        let sz = dot(S, surf.N);
        if (camera.sunDirection.w > 0.0 && factors.pomShadow > 0.0 && sz > 0.0) {
            let sunUvRay = vec2<f32>(dot(S, surf.dirU), dot(S, surf.dirV)) / max(sz, MIN_VIEW_COS)
                         * depthScale * surf.scale;
            shadow = mix(1.0, reliefShadow(hit, sunUvRay, lod), factors.pomShadow);
        }
#endif
    }

    // ── Texture sampling with the undisplaced gradients ───────────────────────
    // dpdx of the displaced uv jumps at relief steps and picks tiny mips there (sparkles
    // along every stone edge). Texture UVs keep the camera jitter on purpose: TAA/TSR
    // integrate the sub-pixel offsets; camera.mipBias compensates their blur.
    let g  = exp2(camera.mipBias);
    let gx = surf.duvdx * g;
    let gy = surf.duvdy * g;
    // These anisotropic fetches (explicit gradients) are what this shader spends most on —
    // not the march, whose SampleLevel reads skip anisotropy. So the cheap height lookup
    // comes first and decides which maps can show at all: none under a full layer of ash,
    // not the base under a full layer, not the layer where it has no weight. Each skip
    // only drops a term the mixes below would multiply by 0.
    let heightHit = surfaceHeight(uvFinal, lod, 0.0);
    let wLayer    = heightHit.y;
    var ashFilled = 0.0;
#ifdef ASH
    let ashEdge = max(factors.ashSharpness, 1e-3);
    ashFilled = smoothstep(-ashEdge, ashEdge, gAshLevel - heightHit.x);
#endif
    let visible = ashFilled < 1.0;

    var albedo   = vec3<f32>(0.0);
    var metallic = 0.0;
    var roughRaw = 1.0;
    var N_ts     = vec3<f32>(0.0, 0.0, 1.0);
    if (visible && wLayer < 1.0) {
        albedo   = sampleBase(txAlbedo, uvFinal, gx, gy).rgb * factors.baseColorFactor.rgb;
        roughRaw = sampleBase(txRoughness, uvFinal, gx, gy).g;
        N_ts     = sampleBase(txNormal, uvFinal, gx, gy).xyz * 2.0 - 1.0;
        // Uniform: most materials leave black.png with factor 0 here.
        if (factors.metallicFactor != 0.0) {
            metallic = sampleBase(txMetallic, uvFinal, gx, gy).b * factors.metallicFactor;
        }
    }
    var emissive = 0.0;
    if (factors.emissiveFactor != 0.0) {
        emissive = sampleBase(txEmissive, uvFinal, gx, gy).x * factors.emissiveFactor;
    }

#ifdef LAYER
    if (visible && wLayer > 0.0) {
        let uvL = uvFinal * gLayerRatio;
        let gxL = gx * gLayerRatio;
        let gyL = gy * gLayerRatio;
        let tint = vec3<f32>(factors.layerTintR, factors.layerTintG, factors.layerTintB);
        albedo   = mix(albedo, textureSampleGrad(txAlbedo2, samplerState, uvL, gxL, gyL).rgb * tint, wLayer);
        roughRaw = mix(roughRaw, textureSampleGrad(txRoughness2, samplerState, uvL, gxL, gyL).g, wLayer);
        N_ts     = mix(N_ts, textureSampleGrad(txNormal2, samplerState, uvL, gxL, gyL).xyz * 2.0 - 1.0, wLayer);
        metallic = mix(metallic, 0.0, wLayer);
    }
#endif

#ifdef DIRT
    {
        let dirtColor = vec3<f32>(factors.dirtColorR, factors.dirtColorG, factors.dirtColorB);
        // Cavities: the lower the relief, the dirtier.
        var dirt = factors.cavityDirt * (1.0 - smoothstep(0.1, 0.65, heightHit.x));
#ifdef BOX
        if (factors.baseDirtHeight > 0.0) {
            // Height above the bottom of the box, at the displaced point; noisy border,
            // and only on the sides (the top never touches the floor).
            let p    = input.WorldPos - V / vz * hitDepth;
            let up   = dot(p - input.BoxCenter, input.BoxAxisY) + input.BoxHalf.y;
            let n    = fbm3(p * 3.0);
            let band = 1.0 - smoothstep(0.0, factors.baseDirtHeight, up - (n - 0.5) * factors.baseDirtHeight);
            let side = 1.0 - abs(dot(surf.N, input.BoxAxisY));
            dirt = max(dirt, band * side * factors.baseDirtStrength);
        }
#endif
        albedo   = mix(albedo, dirtColor * (0.7 + 0.6 * albedo), dirt);
        roughRaw = mix(roughRaw, 1.0, dirt * 0.6);
        metallic = mix(metallic, 0.0, dirt);
    }
#endif

#ifdef ASH
    {
        // Ash where its level is above the surface (with a soft rim), plus a thin dusting
        // on the exposed tops. The ash surface is flat: its normal is the face's.
        let filled  = ashFilled;
        let dusting = min(gAshLevel, 1.0) * 0.45;
        let ash     = max(filled, dusting);
        let ashColor = vec3<f32>(factors.ashColorR, factors.ashColorG, factors.ashColorB);
        albedo   = mix(albedo, ashColor, ash);
        roughRaw = mix(roughRaw, 1.0, ash);
        metallic = mix(metallic, 0.0, ash);
        N_ts     = mix(N_ts, vec3<f32>(0.0, 0.0, 1.0), filled);
    }
#endif

    let N = normalize(surf.mapT * N_ts.x + surf.mapB * N_ts.y + surf.N * N_ts.z);

    // ── Specular anti-aliasing (same as gbuffer.fs) ───────────────────────────
    let dndx         = dpdx(N);
    let dndy         = dpdy(N);
    let variance     = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2 = min(2.0 * variance * 0.25, 0.18);
    let rough2       = clamp(roughRaw * roughRaw + kernelRough2, 0.0, 1.0);
    let roughness    = sqrt(rough2);

    var output: FragmentOutput;
    // Albedo is bound through an sRGB view: the hardware already decoded it to linear.
    output.albedo = vec4<f32>(albedo * shadow, metallic);
    output.normal = vec4<f32>(normalToOctahedral01(N), roughness * factors.roughnessFactor, emissive);

    // Geometric depth = top of the relief (see header). Pushing it down to the hit would
    // make the shadow-map test see the mesh's own surface above every crack.
    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    output.depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    return output;
}
