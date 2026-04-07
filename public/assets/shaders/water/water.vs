#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txNoise1: texture_2d<f32>;
@group(1) @binding(1) var txNoise2: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> VertexOutput {
    var output: VertexOutput;

    let t = camera.time;

    // Undisplaced world position — used for world-space noise UVs so cube
    // faces (or any tiled meshes) sample the same noise at shared edges.
    let undisplacedWorld = object.modelMatrix * vec4<f32>(position, 1.0);
    let worldXZ = undisplacedWorld.xz;

    // Two noise layers scrolling in different directions for wave animation.
    // Scale by uvXScale/uvYScale so the user can tune tile frequency.
    let noiseUV1 = worldXZ * factors.uvXScale * 0.05 + vec2<f32>(t * 0.06, t * 0.04);
    let noiseUV2 = worldXZ * factors.uvYScale * 0.05 + vec2<f32>(-t * 0.04, t * 0.07);

    let noise1 = textureSampleLevel(txNoise1, samplerState, noiseUV1, 0.0).r;
    let noise2 = textureSampleLevel(txNoise2, samplerState, noiseUV2, 0.0).g;

    // Combine layers for displacement along surface normal (max 0.2 world units)
    let displacement = (noise1 * 0.6 + noise2 * 0.4 - 0.5) * 0.2;

    // Apply displacement in world-normal direction
    let model3x3 = get3x3From4x4(object.modelMatrix);
    let worldNormal = normalize(model3x3 * normal);
    let displacedWorld = undisplacedWorld.xyz + worldNormal * displacement;
    let worldPos = vec4<f32>(displacedWorld, 1.0);

    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    output.Uv = uv;

    return output;
}
