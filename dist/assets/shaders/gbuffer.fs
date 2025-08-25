#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> baseColorFactor: vec4<f32>;


@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let albedo_color = textureSample(txAlbedo, samplerState, input.Uv);
    
    var output: FragmentOutput;

    output.albedo = albedo_color * baseColorFactor;
    output.albedo.a = textureSample(txMetallic, samplerState, input.Uv).b;

    // Obtener la normal del normal map
    let N_tangent_space = textureSample(txNormal, samplerState, input.Uv) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);    
    
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g;
    let encodedNormal = normalToOctahedral01(N);

    let emissive = textureSample(txEmissive, samplerState, input.Uv).x;

    // Pack octahedral normal + roughness en RGBA8
    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness,
        emissive
    );

    let camb2obj = input.WorldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    output.depth = linear_depth;

    return output;
}