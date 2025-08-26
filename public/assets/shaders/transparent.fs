#include "common/structs"
#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var txAlbedo: texture_2d<f32>;
@group(2) @binding(1) var txNormal: texture_2d<f32>;
@group(2) @binding(2) var txMetallic: texture_2d<f32>;
@group(2) @binding(3) var txRoughness: texture_2d<f32>;
@group(2) @binding(4) var txEmissive: texture_2d<f32>;
@group(2) @binding(5) var samplerState: sampler;


@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let textureColor = textureSample(txAlbedo, samplerState, input.Uv);
    
    return vec4<f32>(textureColor.xyz, 0.5);
}