#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

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
