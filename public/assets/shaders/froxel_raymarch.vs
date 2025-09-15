// Froxel Ray Marching Vertex Shader
// Renders fullscreen quad for volumetric ray marching

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    screenSize: vec2<f32>,
    cameraFront: vec3<f32>,
    cameraZFar: f32,
    invProjection: mat4x4<f32>,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) worldPos: vec3<f32>,
}

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Fullscreen quad position (already in NDC space [-1,1])
    output.position = vec4<f32>(input.position.xy, 0.0, 1.0); // Z=0 for fullscreen quad
    
    // Convert NDC [-1,1] to UV [0,1]
    output.uv = input.position.xy * vec2<f32>(0.5, -0.5) + 0.5;
    
    // Calculate world position for ray marching using inverse view-projection
    // Direct transformation from NDC to world space (much simpler!)
    let ndcPos = vec4<f32>(input.position.xy, 1.0, 1.0); // Z=1 for far plane
    let worldPos4 = camera.invViewProjection * ndcPos;
    output.worldPos = worldPos4.xyz / worldPos4.w; // Perspective divide
    
    return output;
}
