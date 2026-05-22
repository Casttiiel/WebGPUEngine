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

// ── Terrain splat fragment shader ─────────────────────────────────────────────
// Blends up to three tiling PBR texture layers (ground, rock, snow) using
// per-chunk splat weight maps with height-based blending.
//
// Height-based blending (UE5 / id-Tech style):
//   Each albedo.A encodes a per-layer height field [0,1].  Combined with the
//   splat weight, this makes transitions sharp and physically plausible — rocks
//   protrude through snow, grass fills valleys — instead of the mushy linear
//   interpolation of a naive weighted blend.  Controlled by factors.pomScale
//   (repurposed as heightBlendDepth; 0 = disable, 0.1–0.3 typical).
//
// Group 1 custom material slots (see terrain_splat.tech):
//   binding  0  txSplat       — RGBA8 per-chunk splat weights (R=ground, G=rock, B=snow)
//   binding  1  txLayer0Alb   — layer 0 albedo (ground)  • alpha = height field
//   binding  2  txLayer0Nrm   — layer 0 normal
//   binding  3  txLayer1Alb   — layer 1 albedo (rock)    • alpha = height field
//   binding  4  txLayer1Nrm   — layer 1 normal
//   binding  5  txLayer2Alb   — layer 2 albedo (snow)    • alpha = height field
//   binding  6  txLayer2Nrm   — layer 2 normal
//   binding  7  txChunkNormal — per-chunk terrain shape normal map
//   binding  8  samplerState  — anisotropic sampler
//   binding  9  factors       — MaterialFactors
//                                 uvXScale/uvYScale     — tiling scale
//                                 baseColorFactor.rgb   — albedo tint
//                                 roughnessFactor       — global roughness multiplier
//                                 pomScale              — height blend depth (0 = disabled)
//   binding 10  txLayer0Rgh   — layer 0 roughness (R channel)
//   binding 11  txLayer1Rgh   — layer 1 roughness (R channel)
//   binding 12  txLayer2Rgh   — layer 2 roughness (R channel)
// ─────────────────────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0)  var txSplat:       texture_2d<f32>;
@group(1) @binding(1)  var txLayer0Alb:   texture_2d<f32>;
@group(1) @binding(2)  var txLayer0Nrm:   texture_2d<f32>;
@group(1) @binding(3)  var txLayer1Alb:   texture_2d<f32>;
@group(1) @binding(4)  var txLayer1Nrm:   texture_2d<f32>;
@group(1) @binding(5)  var txLayer2Alb:   texture_2d<f32>;
@group(1) @binding(6)  var txLayer2Nrm:   texture_2d<f32>;
@group(1) @binding(7)  var txChunkNormal: texture_2d<f32>;
@group(1) @binding(8)  var samplerState:  sampler;
@group(1) @binding(9)  var<uniform> factors: MaterialFactors;
@group(1) @binding(10) var txLayer0Rgh:   texture_2d<f32>;
@group(1) @binding(11) var txLayer1Rgh:   texture_2d<f32>;
@group(1) @binding(12) var txLayer2Rgh:   texture_2d<f32>;

// ── Whiteout normal blend ─────────────────────────────────────────────────────
// Combines two tangent-space normals where n1 is the base (macro) and n2 is the
// detail (micro).  Whiteout blend preserves both contributions better than
// additive or overlay blends at grazing angles.
fn blendNormalsWhiteout(n1: vec3<f32>, n2: vec3<f32>) -> vec3<f32> {
    return normalize(vec3<f32>(n1.xy + n2.xy, max(n1.z * n2.z, 0.001)));
}

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    // ── UVs ──────────────────────────────────────────────────────────────────
    // Per-chunk UV [0,1] — used for splat and chunk normal maps.
    let uvChunk = input.Uv;

    // Tiled UV — used for repeating layer textures.
    let uvTiled = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);

    // UV unjittering: TAA jitters the projection sub-pixel every frame, shifting
    // interpolated UVs and causing mip selection variance → texture shimmer.
    // Remove the jitter from the tiled UV before sampling high-frequency textures.
    let jitter_px = camera.jitterOffset * camera.screenSize;
    let uvTiledU  = uvTiled - dpdx(uvTiled) * jitter_px.x - dpdy(uvTiled) * jitter_px.y;

    // ── Splat weights ─────────────────────────────────────────────────────────
    // R = ground/grass, G = rock, B = snow.  Pre-normalised in TerrainSplatGenerator.
    let splatRaw = textureSample(txSplat, samplerState, uvChunk);
    let wGround  = splatRaw.r;
    let wRock    = splatRaw.g;
    let wSnow    = splatRaw.b;

    // ── Albedo sample (RGBA — alpha carries per-layer height field) ────────────
    let alb0 = textureSampleBias(txLayer0Alb, samplerState, uvTiledU, camera.mipBias);
    let alb1 = textureSampleBias(txLayer1Alb, samplerState, uvTiledU, camera.mipBias);
    let alb2 = textureSampleBias(txLayer2Alb, samplerState, uvTiledU, camera.mipBias);

    // ── Height-based blend weights ────────────────────────────────────────────
    // factors.pomScale is repurposed as heightBlendDepth (0 = linear fallback).
    // albedo.a encodes a per-layer height field; combined with the splat weight
    // it biases which layer "wins" at each pixel.  When albedo.a == 1 (standard
    // textures without packed height) the formula still sharpens transitions by
    // applying a soft-max: only layers within `depth` of the dominant weight
    // survive, producing crisper edges without requiring special texture authoring.
    let heightBlendDepth = factors.pomScale;
    var bw0: f32;
    var bw1: f32;
    var bw2: f32;
    if (heightBlendDepth > 0.001) {
        let h0   = alb0.a * wGround;
        let h1   = alb1.a * wRock;
        let h2   = alb2.a * wSnow;
        let maxH = max(h0, max(h1, h2));
        let hw0  = max(h0 - (maxH - heightBlendDepth), 0.0);
        let hw1  = max(h1 - (maxH - heightBlendDepth), 0.0);
        let hw2  = max(h2 - (maxH - heightBlendDepth), 0.0);
        let hwSum = hw0 + hw1 + hw2 + 0.0001;
        bw0 = hw0 / hwSum;
        bw1 = hw1 / hwSum;
        bw2 = hw2 / hwSum;
    } else {
        // Height blending disabled — use raw splat weights (original behaviour).
        bw0 = wGround;
        bw1 = wRock;
        bw2 = wSnow;
    }

    // ── Albedo blend ──────────────────────────────────────────────────────────
    let albedoBlended = alb0.rgb * bw0 + alb1.rgb * bw1 + alb2.rgb * bw2;

    // Linearise sRGB before applying the colour factor.
    let albedoLinear  = pow(abs(albedoBlended), vec3<f32>(2.2));
    let albedoFinal   = albedoLinear * factors.baseColorFactor.rgb;

    // ── Detail normal blend ───────────────────────────────────────────────────
    // Decode from [0,1] texture storage to signed [-1,1] tangent-space vectors.
    let n0 = textureSampleBias(txLayer0Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;
    let n1 = textureSampleBias(txLayer1Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;
    let n2 = textureSampleBias(txLayer2Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;

    let detailNormal = normalize(n0 * bw0 + n1 * bw1 + n2 * bw2);

    // ── Macro (chunk) normal ──────────────────────────────────────────────────
    // Phase 4 normal map: encodes the heightmap-derived shape in tangent space.
    // Flat terrain → (0.5, 0.5, 1.0) stored, decoded to (0,0,1).
    let chunkNormal = textureSample(txChunkNormal, samplerState, uvChunk).xyz * 2.0 - 1.0;

    // Whiteout blend: chunk shape + detail layer
    let blendedTS = blendNormalsWhiteout(chunkNormal, detailNormal);

    // ── World-space normal via TBN ────────────────────────────────────────────
    let TBN = computeTBN(normalize(input.N), input.T);
    let N   = normalize(TBN * blendedTS);

    // ── Roughness blend ───────────────────────────────────────────────────────
    // Per-layer roughness textures (R channel).  factors.roughnessFactor is a
    // global multiplier (1.0 = no change).  Height-blended weights used so
    // roughness tracks the same layer dominance as albedo and normals.
    let rgh0 = textureSampleBias(txLayer0Rgh, samplerState, uvTiledU, camera.mipBias).r;
    let rgh1 = textureSampleBias(txLayer1Rgh, samplerState, uvTiledU, camera.mipBias).r;
    let rgh2 = textureSampleBias(txLayer2Rgh, samplerState, uvTiledU, camera.mipBias).r;
    let roughnessRaw = (rgh0 * bw0 + rgh1 * bw1 + rgh2 * bw2) * factors.roughnessFactor;

    // ── Specular Anti-Aliasing (Toksvigs) ────────────────────────────────────
    let dndx = dpdx(N);
    let dndy = dpdy(N);
    let variance      = dot(dndx, dndx) + dot(dndy, dndy);
    let saaBias       = 0.25;
    let kernelRough2  = min(2.0 * variance * saaBias, 0.18);
    let rough2        = clamp(roughnessRaw * roughnessRaw + kernelRough2, 0.0, 1.0);
    let roughness     = sqrt(rough2);

    // ── GBuffer output ────────────────────────────────────────────────────────
    let encodedNormal = normalToOctahedral01(N);

    var output: FragmentOutput;

    output.albedo = vec4<f32>(albedoFinal, 0.0); // alpha = metallic (terrain = 0)

    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness,
        0.0 // no emissive on terrain
    );

    let camb2obj   = input.WorldPos - camera.cameraPosition.xyz;
    output.depth   = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;

    return output;
}
