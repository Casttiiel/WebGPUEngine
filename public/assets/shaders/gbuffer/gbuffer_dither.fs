#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

// ── Dithered transparency GBuffer fill ───────────────────────────────────────
// Replaces the hard alpha < 0.5 discard from gbuffer_mask.fs with a Bayer 4×4
// ordered-dither threshold. Each pixel is either fully opaque or discarded based
// on comparing the material alpha against the per-pixel dither value, creating
// the illusion of partial transparency at no blending cost.
//
// Alpha interpretation:
//   1.0 → all 16 thresholds pass  → fully opaque
//   0.0 → all 16 thresholds fail  → fully invisible
//   0.5 → ~8 / 16 pixels survive  → appears 50 % transparent
//
// Surviving pixels enter the GBuffer normally and receive all deferred lighting
// (shadows, AO, SSR, IBL) — no OIT overhead, no depth-sort required.
//
// Use case: LOD cross-fades, dissolve effects, foliage with soft alpha cutout.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

// ── Bayer 4×4 ordered dither matrix ──────────────────────────────────────────
// Values normalised to [0, 1). Threshold at index (x%4, y%4):
//   0.0 / 16  →  first to survive (very low alpha passes this tile)
//  15.0 / 16  →  last  to survive (only near-opaque alpha reaches this tile)
fn bayer4(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let Uv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);

    let albedo_color = textureSample(txAlbedo, samplerState, Uv);

    // Dither discard: pixel survives iff alpha > its Bayer threshold.
    // Combine texture alpha with the material baseColorFactor alpha so that
    // setting baseColorFactor[3] < 1.0 controls the effective transparency.
    //   baseColorFactor.a = 1.0 → fully opaque
    //   baseColorFactor.a = 0.5 → ~8/16 pixels discarded → 50% transparent
    //   baseColorFactor.a = 0.0 → fully invisible
    let alpha = albedo_color.a * factors.baseColorFactor.a;
    let pixelCoord = vec2<u32>(input.position.xy);
    if (alpha <= bayer4(pixelCoord)) {
        discard;
    }

    var output: FragmentOutput;

    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo     = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, albedo_color.a);
    output.albedo.a   = textureSample(txMetallic, samplerState, Uv).b * factors.metallicFactor;

    let N_tangent_space = textureSample(txNormal, samplerState, Uv) * 2.0 - 1.0;
    let TBN = computeTBN(normalize(input.N), input.T);
    let N   = normalize(TBN * N_tangent_space.xyz);

    let roughness_raw = textureSample(txRoughness, samplerState, Uv).g * factors.roughnessFactor;
    let dndx = dpdx(N);
    let dndy = dpdy(N);
    let variance     = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2 = min(2.0 * variance * 0.25, 0.18);
    let rough2       = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness    = sqrt(rough2);
    let encodedNormal = normalToOctahedral01(N);

    let emissive = textureSample(txEmissive, samplerState, Uv).x * factors.emissiveFactor;

    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness,
        emissive,
    );

    let camb2obj    = input.WorldPos - camera.cameraPosition.xyz;
    let linear_depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    output.depth    = linear_depth;

    return output;
}
