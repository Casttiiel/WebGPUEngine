#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var skyboxTexture: texture_cube<f32>;
@group(1) @binding(1) var skyboxSampler: sampler;

fn get_view_dir(clip_pos: vec3<f32>) -> vec3<f32> {
    // Para una matriz de proyección perspectiva, podemos reconstruir la dirección en view space
    // usando el fov y aspect ratio implícitos en la matriz de proyección
    let fov = atan(1.0 / camera.projectionMatrix[1][1]); // Extract FOV from projection matrix
    let aspect = camera.projectionMatrix[1][1] / camera.projectionMatrix[0][0]; // Extract aspect ratio
    
    // Reconstruir la dirección en view space
    var view_dir = vec3<f32>(
        clip_pos.x * tan(fov) * aspect,
        clip_pos.y * tan(fov),
        -1.0
    );
    
    return normalize(view_dir);
}

fn get_world_dir(view_dir: vec3<f32>) -> vec3<f32> {
    // Para el skybox, solo necesitamos la inversa de la rotación de la vista
    // Lo cual es equivalente a la transpuesta de la matriz 3x3 superior izquierda
    let rotation = transpose(mat3x3<f32>(
        camera.viewMatrix[0].xyz,
        camera.viewMatrix[1].xyz,
        camera.viewMatrix[2].xyz
    ));
    
    return rotation * view_dir;
}

@fragment
fn fs(@location(0) position_clip: vec3<f32>) -> @location(0) vec4<f32> {
    // Obtenemos la dirección en view space
    let view_dir = get_view_dir(position_clip);
    
    // Convertimos a world space manteniendo solo la rotación
    let sample_dir = get_world_dir(view_dir);
    
    // Sample the cubemap - el vector debe estar normalizado
    let color = textureSample(skyboxTexture, skyboxSampler, sample_dir);
    return vec4<f32>(color.rgb, 1.0);
}