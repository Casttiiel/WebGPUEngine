#include "common/uniforms"
#include "common/math/coordinates"

// Procedural skybox uniforms
struct SkyboxProceduralUniforms {
  sunDirection: vec3<f32>,  // Real sun direction (for scattering)
  timeOfDay: f32,           // Time of day [0, 1]
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> u_procedural: SkyboxProceduralUniforms;

// Sky colors
const SKY_COLOR_ZENITH: vec3<f32> = vec3<f32>(0.2, 0.4, 0.9);      // Deep blue
const SKY_COLOR_HORIZON: vec3<f32> = vec3<f32>(0.7, 0.85, 1.0);    // Light blue
const SUNSET_COLOR: vec3<f32> = vec3<f32>(1.0, 0.5, 0.2);          // Orange
const NIGHT_SKY_COLOR: vec3<f32> = vec3<f32>(0.01, 0.02, 0.05);    // Very dark
const SUN_INTENSITY: f32 = 30.0;

fn atmosphere_scattering(view_dir: vec3<f32>, sun_dir: vec3<f32>) -> vec3<f32> {
    let cos_theta = dot(view_dir, sun_dir);
    let view_height = view_dir.y;
    let sun_height = sun_dir.y;
    
    // Much wider transition range for day/night (-0.3 to 0.3)
    let sun_above = smoothstep(-0.3, 0.3, sun_height);
    
    // Day sky gradient (stronger contrast)
    let zenith_factor = pow(smoothstep(-0.1, 0.8, view_height), 0.7);
    let day_sky = mix(SKY_COLOR_HORIZON, SKY_COLOR_ZENITH, zenith_factor);
    
    // Sunset/sunrise (more prominent, wider angle)
    let sunset_angle = pow(max(0.0, cos_theta), 4.0);
    let sunset_height = 1.0 - abs(sun_height * 2.0);  // Max at horizon
    let sunset_factor = sunset_angle * smoothstep(-0.2, 0.5, sunset_height);
    let sunset_contribution = SUNSET_COLOR * sunset_factor * 3.0;
    
    // Strong blend between night and day
    var sky_color = mix(NIGHT_SKY_COLOR, day_sky, sun_above);
    sky_color += sunset_contribution * smoothstep(-0.2, 0.2, sun_height);
    
    // Brighter sun disk
    let sun_disk = smoothstep(0.9995, 0.9999, cos_theta);
    sky_color += vec3<f32>(sun_disk) * SUN_INTENSITY * max(0.0, sun_height);
    
    return sky_color;
}

@fragment
fn fs(@location(0) position_clip: vec3<f32>) -> @location(0) vec4<f32> {
    var view_dir = get_view_dir(position_clip, camera);
    var world_dir = get_world_dir(view_dir, camera);
    world_dir = normalize(world_dir);
    
    let sun_dir = normalize(u_procedural.sunDirection);
    let sky_color = atmosphere_scattering(world_dir, sun_dir);
    
    return vec4<f32>(sky_color, 1.0);
}
