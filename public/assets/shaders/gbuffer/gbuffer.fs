#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;


@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let Uv = input.Uv * vec2<f32>(factors.uvXScale,factors.uvYScale);

    // Texture UVs keep the camera jitter on purpose: TAA/TSR integrate the sub-pixel
    // offsets over frames, which is what anti-aliases texture detail. (camera.mipBias
    // compensates the extra blur of that integration.)

    let albedo_color = textureSampleBias(txAlbedo, samplerState, Uv, camera.mipBias);
    
    var output: FragmentOutput;

    // Albedo is bound through an sRGB view: the hardware decodes to linear before filtering,
    // so the factor scales linear energy (glTF reference: linear(sRGB) * linearFactor).
    let albedo_linear = albedo_color.rgb;
    output.albedo = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, albedo_color.a);
    output.albedo.a = textureSampleBias(txMetallic, samplerState, Uv, camera.mipBias).b * factors.metallicFactor;

    // Obtener la normal del normal map
    let N_tangent_space = textureSampleBias(txNormal, samplerState, Uv, camera.mipBias) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);    
    
    let roughness_raw = textureSampleBias(txRoughness, samplerState, Uv, camera.mipBias).g * factors.roughnessFactor;

    // ── Specular Anti-Aliasing (Toksvigs / Kanis 2013) ───────────────────────
    // High-frequency normal maps introduce specular variance that is not captured
    // in the stored roughness value.  At distance (lower mips) the averaged normal
    // appears smoother than the real micro-surface, making specular highlights narrow
    // and aliased.  We estimate the per-pixel normal variance from screen-space
    // derivatives and add it to roughness² before writing it to the GBuffer.
    // This is what Sketchfab, UE5 and Frostbite all do.
    let dndx = dpdx(N);
    let dndy = dpdy(N);
    // variance = sum of squared lengths of the screen-space normal gradient
    let variance = dot(dndx, dndx) + dot(dndy, dndy);
    // Bias limits the maximum roughness increase to avoid over-blurring flat surfaces
    let saaBias       = 0.25;
    let kernelRough2  = min(2.0 * variance * saaBias, 0.18);
    let rough2        = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness     = sqrt(rough2);
    // ─────────────────────────────────────────────────────────────────────────
    let encodedNormal = normalToOctahedral01(N);

    let emissive = textureSampleBias(txEmissive, samplerState, Uv, camera.mipBias).x * factors.emissiveFactor;

    // Pack octahedral normal + roughness en RGBA8
    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness,
        emissive
    );

    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    let linear_depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    output.depth = linear_depth;

    return output;
}