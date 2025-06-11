struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    inverseProjection: mat4x4<f32>,  // Necesitamos la inversa de la proyección
    SourceSize: vec2<f32>
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) position_clip: vec3<f32>
}

@vertex
fn vs(@location(0) position: vec3<f32>,) -> VertexOutput {
    var output: VertexOutput;
    
    // Mantenemos las posiciones del quad en clip space
    output.position = vec4<f32>(position.xy, 1.0, 1.0);
    
    // Guardamos la posición en clip space para reconstruir la dirección en el fragment shader
    output.position_clip = position;
    
    return output;
}