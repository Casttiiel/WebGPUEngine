#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

// ── Terrain splat fragment shader ─────────────────────────────────────────────
// Blends up to three tiling texture layers (ground, rock, snow) using per-chunk
// splat weight maps.  The per-chunk normal map (Phase 4) captures the macro
// terrain shape; it is whiteout-blended with the weighted detail normals before
// world-space transformation via TBN.
//
// Group 1 custom material slots (see terrain_splat.tech):
//   binding 0  txSplat       — RGBA8 per-chunk splat weights (R=ground, G=rock, B=snow)
//   binding 1  txLayer0Alb   — layer 0 albedo (ground)
//   binding 2  txLayer0Nrm   — layer 0 normal
//   binding 3  txLayer1Alb   — layer 1 albedo (rock)
//   binding 4  txLayer1Nrm   — layer 1 normal
//   binding 5  txLayer2Alb   — layer 2 albedo (snow)
//   binding 6  txLayer2Nrm   — layer 2 normal
//   binding 7  txChunkNormal — per-chunk terrain shape normal map
//   binding 8  samplerState  — anisotropic sampler
//   binding 9  factors       — MaterialFactors (uvXScale/uvYScale/baseColorFactor …)
// ─────────────────────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txSplat:       texture_2d<f32>;
@group(1) @binding(1) var txLayer0Alb:   texture_2d<f32>;
@group(1) @binding(2) var txLayer0Nrm:   texture_2d<f32>;
@group(1) @binding(3) var txLayer1Alb:   texture_2d<f32>;
@group(1) @binding(4) var txLayer1Nrm:   texture_2d<f32>;
@group(1) @binding(5) var txLayer2Alb:   texture_2d<f32>;
@group(1) @binding(6) var txLayer2Nrm:   texture_2d<f32>;
@group(1) @binding(7) var txChunkNormal: texture_2d<f32>;
@group(1) @binding(8) var samplerState:  sampler;
@group(1) @binding(9) var<uniform> factors: MaterialFactors;

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

    // ── Albedo blend ──────────────────────────────────────────────────────────
    let alb0 = textureSampleBias(txLayer0Alb, samplerState, uvTiledU, camera.mipBias);
    let alb1 = textureSampleBias(txLayer1Alb, samplerState, uvTiledU, camera.mipBias);
    let alb2 = textureSampleBias(txLayer2Alb, samplerState, uvTiledU, camera.mipBias);

    let albedoBlended = alb0 * wGround + alb1 * wRock + alb2 * wSnow;

    // Linearise sRGB before applying the colour factor.
    let albedoLinear  = pow(abs(albedoBlended.rgb), vec3<f32>(2.2));
    let albedoFinal   = albedoLinear * factors.baseColorFactor.rgb;

    // ── Detail normal blend ───────────────────────────────────────────────────
    // Decode from [0,1] texture storage to signed [-1,1] tangent-space vectors.
    let n0 = textureSampleBias(txLayer0Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;
    let n1 = textureSampleBias(txLayer1Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;
    let n2 = textureSampleBias(txLayer2Nrm, samplerState, uvTiledU, camera.mipBias).xyz * 2.0 - 1.0;

    let detailNormal = normalize(n0 * wGround + n1 * wRock + n2 * wSnow);

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
    // Per-layer roughness constants (no roughness texture needed for terrain).
    let roughGround: f32 = 0.85;
    let roughRock:   f32 = 0.70;
    let roughSnow:   f32 = 0.50;
    let roughnessRaw = roughGround * wGround + roughRock * wRock + roughSnow * wSnow;

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
