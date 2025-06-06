struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldDir: vec3<f32>,
}

@vertex
fn vs(@location(0) position: vec3<f32>,) -> VertexOutput {
    var output: VertexOutput;
    
    // The position remains in clip space
    output.position = vec4<f32>(position.xy, 1.0, 1.0);

    // Convert clip space coordinates to view space direction
    let viewDir = vec3<f32>(position.xy, 1.0);
    
    // Get the rotation-only part of the view matrix and invert it
    let invView = transpose(get3x3From4x4(camera.viewMatrix));
    
    // Transform to world space
    output.worldDir = invView * viewDir;
    
    return output;
}