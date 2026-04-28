#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

struct ViewModelOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fs(input: VertexOutput) -> ViewModelOutput {
    let albedo = textureSample(txAlbedo, samplerState, input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale));
    let albedo_linear = pow(abs(albedo.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;

    // Simple half-lambert shading with a fixed world light — enough to read volume on the mesh
    let lightDir = normalize(vec3<f32>(0.4, 1.0, 0.5));
    let ndotl = dot(normalize(input.N), lightDir) * 0.5 + 0.5; // half-lambert [0..1]
    let lit = albedo_linear * ndotl;

    var output: ViewModelOutput;
    output.color = vec4<f32>(lit, albedo.a);
    return output;
}
