#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
}

@vertex
fn vs(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // Transform position to world space
    let worldPos = object.modelMatrix * vec4<f32>(in.position, 1.0)  + vec4<f32>(0, 5.0, 0, 0);
    
    // Transform to clip space
    out.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    // Pass world position for linear depth calculation
    out.WorldPos = worldPos.xyz;
    
    // Pass UVs for alpha testing in fragment shader
    out.Uv = in.uv;
    
    // Fill unused fields (needed for VertexOutput compatibility)
    out.N = vec3<f32>(0.0);
    out.T = vec4<f32>(0.0);
    
    return out;
}
