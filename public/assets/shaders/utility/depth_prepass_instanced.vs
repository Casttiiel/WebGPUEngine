#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
    let modelMatrix = instanceMatrices[instanceIdx];
    var out: VertexOutput;
    
    // Transform position to world space
    let worldPos = modelMatrix * vec4<f32>(position, 1.0);
    
    // Transform to clip space
    out.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    // Fill required VertexOutput fields (needed for fragment shader)
    out.WorldPos = worldPos.xyz;
    out.N = normalize((modelMatrix * vec4<f32>(normal, 0.0)).xyz);
    out.Uv = uv;
    out.T = vec4<f32>(normalize((modelMatrix * vec4<f32>(tangent.xyz, 0.0)).xyz), tangent.w);
    
    return out;
}
