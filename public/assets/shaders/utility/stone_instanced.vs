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
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;


struct StoneVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    @location(4) @interpolate(perspective, centroid) LocalPos: vec3<f32>,
    @location(5) @interpolate(perspective, centroid) ModelScale: vec3<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @builtin(instance_index) instanceIdx: u32
) -> StoneVertexOutput {
    let modelMatrix = instanceMatrices[instanceIdx];
    var output: StoneVertexOutput;
    var worldPos = modelMatrix * vec4<f32>(position, 1.0);

    let model3x3 = get3x3From4x4(modelMatrix);
    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);

    // Pasar posición local y escala al fragment shader
    output.WorldPos = worldPos.xyz;
    output.LocalPos = position;
    // Extraer escala de la modelMatrix (asume sin rotación ni shearing)
    output.ModelScale = vec3<f32>(
        length(model3x3[0]),
        length(model3x3[1]),
        length(model3x3[2])
    );

    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    output.Uv = uv;
    return output;
}