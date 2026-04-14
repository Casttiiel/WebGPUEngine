#include "common/structs"
#include "common/uniforms"
#include "common/octahedral"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txNoise1:     texture_2d<f32>;
@group(1) @binding(1) var txNoise2:     texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let t = camera.time;

    // ── Animated noise UVs ────────────────────────────────────────────────────
    let noiseUV1 = fract(input.Uv * factors.uvYScale + vec2<f32>(t * 0.06, t * 0.04));
    let noiseUV2 = fract(input.Uv * factors.uvYScale + vec2<f32>(-t * 0.03, t * 0.08));

    let n1 = textureSample(txNoise1, samplerState, noiseUV1).rgb;
    let n2 = textureSample(txNoise2, samplerState, noiseUV2).rgb * 2.0 - 1.0;

    // ── Perturbed surface normal ──────────────────────────────────────────────
    let perturbation = normalize(n1 * 0.65 + n2 * 0.35) * 0.15;
    let N = normalize(input.N + perturbation);
    let encodedNormal = normalToOctahedral01(N);

    // ── Linear depth (same normalised space as solid GBuffer) ─────────────────
    let camb2frag   = input.WorldPos - camera.cameraPosition.xyz;
    let linearDepth = dot(camb2frag, camera.cameraFront.xyz) / camera.cameraFar;

    // ── Write GBuffer targets ─────────────────────────────────────────────────
    //   RT0 albedo : RGB = base colour,  A = metallic
    //   RT1 normal : RG  = octahedral N, B = roughness, A = emissive (0)
    //   RT2 depth  : R   = linear depth
    var output: FragmentOutput;
    output.albedo = vec4<f32>(factors.baseColorFactor.rgb, factors.metallicFactor);
    output.normal = vec4<f32>(encodedNormal.x, encodedNormal.y, factors.roughnessFactor, 0.0);
    output.depth  = linearDepth;
    return output;
}
