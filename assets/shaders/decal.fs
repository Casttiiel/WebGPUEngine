#include "common/uniforms"
#include "common/structs"
#include "common/utils"

struct DecalFragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) selfIllum: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var txAlbedo: texture_2d<f32>;
@group(2) @binding(1) var txNormal: texture_2d<f32>;
@group(2) @binding(2) var txMetallic: texture_2d<f32>;
@group(2) @binding(3) var txRoughness: texture_2d<f32>;
@group(2) @binding(4) var txEmissive: texture_2d<f32>;
@group(2) @binding(5) var samplerState: sampler;

@fragment
fn fs(input: VertexOutput) -> DecalFragmentOutput {
    let albedo_color = textureSample(txAlbedo, samplerState, input.Uv);
    
    var output: DecalFragmentOutput;

    output.albedo = albedo_color;
    output.albedo.a = textureSample(txMetallic, samplerState, input.Uv).b;
    
    output.selfIllum = textureSample(txEmissive, samplerState, input.Uv);
    output.selfIllum *= output.selfIllum.a;
    return output;
}