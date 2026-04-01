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

    // UV unjittering: remove per-frame jitter displacement to prevent TAA-induced texture blur.
    let jitter_px = camera.jitterOffset * camera.screenSize;
    let uvUnjittered = Uv - dpdx(Uv) * jitter_px.x - dpdy(Uv) * jitter_px.y;

    let albedo_color = textureSample(txAlbedo, samplerState, uvUnjittered);
    
    if(albedo_color.a < 0.5){
        discard;
    }

    var output: FragmentOutput;

    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, albedo_color.a);
    output.albedo.a = textureSample(txMetallic, samplerState, uvUnjittered).b * factors.metallicFactor;

    // Obtener la normal del normal map
    let N_tangent_space = textureSample(txNormal, samplerState, uvUnjittered) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);    
    
    let roughness_raw = textureSample(txRoughness, samplerState, uvUnjittered).g * factors.roughnessFactor;
    let dndx = dpdx(N);
    let dndy = dpdy(N);
    let variance      = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2  = min(2.0 * variance * 0.25, 0.18);
    let rough2        = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness     = sqrt(rough2);
    let encodedNormal = normalToOctahedral01(N);

    let emissive = textureSample(txEmissive, samplerState, uvUnjittered).x * factors.emissiveFactor;

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