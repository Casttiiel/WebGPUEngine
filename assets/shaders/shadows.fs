#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@fragment
fn fs(input: ShadowsVertexOutput) -> @location(0) f32 {
    let camb2obj = input.worldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    
    return linear_depth;
}