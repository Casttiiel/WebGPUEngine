struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    screenSize: vec2<f32>,
    cameraFront: vec3<f32>,
    cameraZFar: f32,
}

struct ObjectUniforms {
    modelMatrix: mat4x4<f32>,
}
