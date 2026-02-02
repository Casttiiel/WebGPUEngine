#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

fn triplanarBlendWeights(n: vec3<f32>) -> vec3<f32> {
    let an = abs(n);
    let w = an / (an.x + an.y + an.z);
    return w;
}

fn triplanarSample(
    tex: texture_2d<f32>,
    smp: sampler,
    worldPos: vec3<f32>,
    blend: vec3<f32>,
    scale: f32
) -> vec4<f32> {
    let xProj = textureSampleLevel(tex, smp, worldPos.yz * scale, 0);
    let yProj = textureSampleLevel(tex, smp, worldPos.xz * scale, 0);
    let zProj = textureSampleLevel(tex, smp, worldPos.xy * scale, 0);

    return xProj * blend.x + yProj * blend.y + zProj * blend.z;
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> VertexOutput {
    var output: VertexOutput;
    var worldPos = object.modelMatrix * vec4<f32>(position, 1.0);

    let model3x3 = get3x3From4x4(object.modelMatrix);
    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);

    let displace_value = textureSampleLevel(txRoughness, samplerState, uv, 0).x;

    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;

    

    output.Uv = uv;
    return output;
}