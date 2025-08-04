#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var skyboxTexture: texture_2d<f32>;
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

fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
    let dir_n = normalize(dir);
    let u = (atan2(dir_n.z, dir_n.x) / (2.0 * 3.1415926535)) + 0.5;
    let v = (asin(dir_n.y) / 3.1415926535) + 0.5;
    return vec2<f32>(u, v);
}

@fragment
fn fs(@location(0) position_clip: vec3<f32>) -> @location(0) vec4<f32> {
    var view_dir = get_view_dir(position_clip);
    var world_dir = get_world_dir(view_dir);
    world_dir.y *= -1.0; // Invert Y for correct skybox orientation
    let uv = direction_to_equirect_uv(world_dir);
    let color = textureSample(skyboxTexture, skyboxSampler, uv);
    return vec4<f32>(clamp(color.xyz, vec3<f32>(0.0), vec3<f32>(16.0)), 1.0);
}