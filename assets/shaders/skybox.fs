#include "common/uniforms"
#include "common/utils"


@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var skyboxTexture: texture_2d<f32>;
@group(1) @binding(1) var skyboxSampler: sampler;

@fragment
fn fs(@location(0) position_clip: vec3<f32>) -> @location(0) vec4<f32> {
    var view_dir = get_view_dir(position_clip);
    var world_dir = get_world_dir(view_dir);
    world_dir.y *= -1.0; // Invert Y for correct skybox orientation
    let uv = direction_to_equirect_uv(world_dir);
    let color = textureSample(skyboxTexture, skyboxSampler, uv);
    return vec4<f32>(clamp(color.xyz, vec3<f32>(0.0), vec3<f32>(16.0)), 1.0);
}