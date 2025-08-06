#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@fragment
fn fs(input: ShadowsVertexOutput) -> @location(0) f32 {
    let camb2obj = input.worldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    
    return 1.0;

    /*    // Convert world position to view space
    let viewPos = camera.viewMatrix * vec4<f32>(input.worldPos, 1.0);
    
    // For orthographic projection, depth is the view space Z coordinate
    // Normalize to [0, 1] using camera far plane (assuming near is close to 0)
    let linear_depth = -viewPos.z / camera.cameraZFar;
    
    // Clamp to [0, 1] range
    let clamped_depth = clamp(linear_depth, 0.0, 1.0);
    
    return clamped_depth;*/
}