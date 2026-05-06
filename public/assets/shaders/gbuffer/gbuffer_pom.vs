#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct POMVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    // View direction in tangent space (from surface to camera).
    // Computed per-vertex and interpolated so the fragment shader can
    // perform the POM ray-march in tangent space without extra matrices.
    @location(4) @interpolate(perspective, centroid) ViewDirTS: vec3<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>
) -> POMVertexOutput {
    var output: POMVertexOutput;

    let worldPos4 = object.modelMatrix * vec4<f32>(position, 1.0);
    let model3x3  = get3x3From4x4(object.modelMatrix);

    let N = normalize(model3x3 * normal);
    let T = normalize(model3x3 * tangent.xyz);
    let B = cross(N, T) * tangent.w;  // bitangent with handedness correction

    output.N        = N;
    output.T        = vec4<f32>(T, tangent.w);
    output.WorldPos = worldPos4.xyz;
    output.Uv       = uv;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos4;

    // Build TBN^T (transpose = inverse for orthonormal) to go world→tangent.
    let tbnT = mat3x3<f32>(
        vec3<f32>(T.x, B.x, N.x),
        vec3<f32>(T.y, B.y, N.y),
        vec3<f32>(T.z, B.z, N.z)
    );

    // View direction world-space (vertex to camera), then into tangent space.
    let viewDirWS = normalize(camera.cameraPosition.xyz - worldPos4.xyz);
    output.ViewDirTS = normalize(tbnT * viewDirWS);

    return output;
}
