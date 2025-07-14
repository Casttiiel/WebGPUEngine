#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
    @location(4) N: vec3<f32>,
    @location(5) T: vec4<f32>,
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> DecalVertexOutput {
    var output: DecalVertexOutput;
    
    // Transform to world space
    let worldPos = object.modelMatrix * vec4<f32>(position, 1.0);
    
    // Transform to clip space
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;

    let model3x3 = get3x3From4x4(object.modelMatrix);
    output.N = normalize(model3x3 * normal);
    output.T = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    
    // Extract decal axes from world matrix
    let center = vec3<f32>(object.modelMatrix[3].x, object.modelMatrix[3].y, object.modelMatrix[3].z);
    let decal_x = vec3<f32>(object.modelMatrix[0].x, object.modelMatrix[0].y, object.modelMatrix[0].z);
    let decal_z = vec3<f32>(object.modelMatrix[2].x, object.modelMatrix[2].y, object.modelMatrix[2].z);
    let decal_y = vec3<f32>(object.modelMatrix[1].x, object.modelMatrix[1].y, object.modelMatrix[1].z);
    
    // Precompute decal projection data
    output.decal_top_left = center - decal_x * 0.5 - decal_z * 0.5;
    let decal_inv_size = 1.0 / dot(decal_x, decal_x);
    output.decal_axis_x = decal_x * decal_inv_size;
    output.decal_axis_z = decal_z * decal_inv_size;
    output.decal_axis_y = decal_y * decal_inv_size;
        
    return output;
}