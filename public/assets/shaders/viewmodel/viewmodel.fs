#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> vmCamera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
@group(3) @binding(0) var<uniform> mainCamera: CameraUniforms;

struct ViewModelOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fs(input: VertexOutput) -> ViewModelOutput {
    let uv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);

    let albedo = textureSample(txAlbedo, samplerState, uv);
    let albedo_linear = pow(abs(albedo.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;

    // Normal in viewmodel camera space (viewmodel camera has identity view,
    // so viewmodel-world == main camera-space).
    let vmNormal = normalize(input.N);

    // Transform to MAIN world space so lighting responds to camera orientation.
    // mainCamera.viewMatrix is world→camera; its transpose (for pure rotation) is camera→world.
    let viewRot = mat3x3<f32>(
        mainCamera.viewMatrix[0].xyz,
        mainCamera.viewMatrix[1].xyz,
        mainCamera.viewMatrix[2].xyz,
    );
    let worldNormal = normalize(transpose(viewRot) * vmNormal);

    // Simple roughness/metallic from textures
    let roughness = textureSample(txRoughness, samplerState, uv).g * factors.roughnessFactor;
    let metallic  = textureSample(txMetallic,  samplerState, uv).b * factors.metallicFactor;

    // Directional (sun-like) light — world space
    let lightDir   = normalize(vec3<f32>(0.55, 0.8, 0.3));
    let lightColor = vec3<f32>(1.2, 1.05, 0.9);

    // Half-Lambert diffuse (wraps to avoid pitch-black shading)
    let ndotl = dot(worldNormal, lightDir) * 0.5 + 0.5;

    // Blinn-Phong specular in viewmodel space (view dir = toward camera origin)
    let viewDir = normalize(-input.WorldPos);
    let halfDir = normalize(lightDir + (transpose(viewRot) * viewDir));
    let specPow = mix(8.0, 128.0, 1.0 - roughness);
    let spec    = pow(max(dot(worldNormal, halfDir), 0.0), specPow) * (1.0 - roughness);

    // Ambient sky light
    let ambient = vec3<f32>(0.12, 0.14, 0.18);

    // Combine diffuse + specular
    let diffuse   = albedo_linear * (ambient + lightColor * ndotl * (1.0 - metallic * 0.8));
    let specColor = mix(vec3<f32>(spec), albedo_linear * spec, metallic) * lightColor;

    var output: ViewModelOutput;
    output.color = vec4<f32>(diffuse + specColor, albedo.a);
    return output;
}
