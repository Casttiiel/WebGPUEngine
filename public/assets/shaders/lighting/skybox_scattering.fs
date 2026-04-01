#include "common/uniforms"
#include "common/math/coordinates"

// Procedural skybox uniforms
struct SkyboxProceduralUniforms {
  sunDirection: vec3<f32>,    // Real sun direction (for scattering)
  timeOfDay: f32,             // Time of day [0, 1]         | offset 12
  windDirection: vec2<f32>,   // Normalized XZ wind direction | offset 16
  cloudThickness: f32,        // Cloud density multiplier     | offset 24
  cloudDistanceFade: f32,     // Elevation at which clouds fully appear | offset 28
  windOffset: f32,            // Accumulated wind displacement | offset 32
  // implicit padding to 48 bytes (struct align 16)
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> u_procedural: SkyboxProceduralUniforms;

// Enhanced sky colors (HDR values for better bloom)
const SKY_ZENITH_DAY: vec3<f32> = vec3<f32>(0.1, 0.3, 0.85);          // Rich blue zenith
const SKY_HORIZON_DAY: vec3<f32> = vec3<f32>(0.5, 0.7, 0.95);         // Light horizon
const SUNSET_ORANGE: vec3<f32> = vec3<f32>(1.8, 0.7, 0.3);            // Vivid orange (HDR)
const SUNSET_PINK: vec3<f32> = vec3<f32>(1.5, 0.4, 0.6);              // Pink/purple (HDR)
const NIGHT_ZENITH: vec3<f32> = vec3<f32>(0.005, 0.01, 0.03);         // Deep night blue
const NIGHT_HORIZON: vec3<f32> = vec3<f32>(0.02, 0.03, 0.06);         // Lighter night horizon
const SUN_COLOR: vec3<f32> = vec3<f32>(1.5, 1.4, 1.2);                // Warm sun (HDR)
const SUN_INTENSITY: f32 = 50.0;                                       // Brighter sun
const MOON_COLOR: vec3<f32> = vec3<f32>(0.8, 0.85, 0.9);              // Cool moon color
const MOON_INTENSITY: f32 = 10.0;                                       // Subtle moon

// Hash function for procedural noise
fn hash13(p3: vec3<f32>) -> f32 {
    var p = fract(p3 * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

fn hash33(p3: vec3<f32>) -> vec3<f32> {
    var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

// Procedural stars
fn generate_stars(dir: vec3<f32>, night_factor: f32) -> vec3<f32> {
    if (night_factor < 0.01) {
        return vec3<f32>(0.0);
    }
    
    // Multiple layers of stars with different densities
    let star_density = 75.0;  // Lower density = bigger stars
    let star_pos = dir * star_density;
    
    // Cell-based stars
    let cell = floor(star_pos);
    let frac_pos = fract(star_pos);
    
    var star_brightness = 0.0;
    var star_color = vec3<f32>(1.0);
    var star_variation = 1.0;  // Store brightness variation per star
    
    // Check 3x3x3 neighborhood for stars
    for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
            for (var k = -1; k <= 1; k++) {
                let neighbor_cell = cell + vec3<f32>(f32(i), f32(j), f32(k));
                let random = hash13(neighbor_cell);
                
                // Star probability (not every cell has a star)
                if (random > 0.94) {
                    // Star position within cell
                    let star_center = hash33(neighbor_cell);
                    let to_star = frac_pos - star_center - vec3<f32>(f32(i), f32(j), f32(k));
                    let dist = length(to_star);
                    
                    // Star brightness (varies per star) - MULTIPLE PIXELS PER STAR
                    let star_size = 0.01 + random * 0.03;  // Much larger
                    let brightness = smoothstep(star_size * 2.0, 0.0, dist);
                    
                    if (brightness > star_brightness) {
                        star_brightness = brightness;
                        star_variation = mix(0.4, 1.0, random);  // Min 40%, Max 100%
                        // Subtle color variation
                        let color_hash = hash33(neighbor_cell * 2.0);
                        star_color = mix(vec3<f32>(1.0), 
                                        vec3<f32>(0.8, 0.9, 1.0), // Slight blue tint
                                        color_hash.x * 0.3);
                    }
                }
            }
        }
    }
    
    // Stars visible only at night, with individual brightness variation
    let star_intensity = star_brightness * night_factor * 15.0 * star_variation;
    return star_color * star_intensity;
}

// Procedural moon with craters
fn render_moon(view_dir: vec3<f32>, moon_dir: vec3<f32>, night_factor: f32) -> vec3<f32> {
    if (night_factor < 0.01) {
        return vec3<f32>(0.0);
    }
    
    let cos_moon = dot(view_dir, moon_dir);
    
    // Moon disk (larger than sun)
    let moon_size = 0.9990; // Slightly larger than sun
    let moon_disk = smoothstep(moon_size, 0.9999, cos_moon);
    
    if (moon_disk < 0.001) {
        return vec3<f32>(0.0);
    }
    
    // UV coordinates on moon surface
    let right = normalize(cross(moon_dir, vec3<f32>(0.0, 1.0, 0.0)));
    let up = cross(right, moon_dir);
    let local_dir = view_dir - moon_dir * cos_moon;
    let u = dot(local_dir, right) * 500.0;
    let v = dot(local_dir, up) * 500.0;
    let moon_uv = vec2<f32>(u, v);
    
    // Moon color (smooth, no surface detail)
    let moon_color = MOON_COLOR;
    
    // Moon glow (subtle)
    let moon_glow = pow(max(0.0, cos_moon), 256.0) * smoothstep(0.997, 0.999, cos_moon);
    
    return (moon_color * moon_disk + moon_color * moon_glow * 0.5) * MOON_INTENSITY * night_factor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud rendering (FBM value noise, top-down UV projection)
// ─────────────────────────────────────────────────────────────────────────────

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f); // Smoothstep
    let a = hash12(i);
    let b = hash12(i + vec2f(1.0, 0.0));
    let c = hash12(i + vec2f(0.0, 1.0));
    let d = hash12(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm_clouds(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var freq = 1.0;
    for (var i = 0; i < 4; i++) {
        value += amplitude * value_noise(p * freq);
        amplitude *= 0.5;
        freq *= 2.1; // Slightly off 2.0 to prevent tiling artefacts
    }
    return value;
}

// Composites procedural clouds onto an existing sky color.
// Stars and moon should already be in sky_color so clouds can correctly occlude them.
fn render_clouds(
    world_dir: vec3<f32>,
    sun_dir: vec3<f32>,
    sky_color: vec3<f32>,
    night_factor: f32,
    sun_height: f32,
) -> vec3<f32> {
    // Only draw clouds in the upper hemisphere
    if (world_dir.y <= 0.001) {
        return sky_color;
    }

    // Top-down planar UV projection: maps hemisphere → flat plane.
    // Scale of 2.0 gives ~3 distinct cloud masses from zenith to 45°.
    // Seed offset breaks the hash12(0,0)=0 degeneracy so zenith always has clouds.
    var uv = world_dir.xz / world_dir.y;
    uv += u_procedural.windDirection * u_procedural.windOffset;
    uv = uv * 2.0 + vec2f(47.3, 31.7);

    // Shape: subtract threshold so noise forms distinct cloud masses
    let raw = fbm_clouds(uv);
    let cloud_density = saturate((raw - 0.42) * u_procedural.cloudThickness);

    // Fade out near horizon to hide UV singularity stretching
    let horizon_fade = smoothstep(0.0, u_procedural.cloudDistanceFade, world_dir.y);
    let final_density = cloud_density * horizon_fade;

    if (final_density < 0.001) {
        return sky_color;
    }

    // Base cloud color — bright white day / dark blue night
    let cloud_day   = vec3f(0.93, 0.95, 0.97);
    let cloud_night = vec3f(0.03, 0.04, 0.09);
    var cloud_color = mix(cloud_night, cloud_day, 1.0 - night_factor);

    // Sunset tint: orange-red when sun is near horizon and clouds align toward sun
    let sunset_window = smoothstep(-0.3, 0.1, sun_height) * smoothstep(0.3, -0.1, sun_height);
    let cos_to_sun    = dot(world_dir, sun_dir);
    let sunset_cloud  = saturate(sunset_window * max(0.0, cos_to_sun));
    cloud_color = mix(cloud_color, SUNSET_ORANGE * 0.75, sunset_cloud);

    return mix(sky_color, cloud_color, final_density);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simplified atmospheric scattering
fn rayleigh_phase(cos_theta: f32) -> f32 {
    // Simplified Rayleigh phase function (blue sky effect)
    return 0.75 * (1.0 + cos_theta * cos_theta);
}

fn atmosphere_scattering(view_dir: vec3<f32>, sun_dir: vec3<f32>) -> vec3<f32> {
    let cos_theta = dot(view_dir, sun_dir);
    let view_height = view_dir.y;
    let sun_height = sun_dir.y;
    
    // Day/night transition (wide smooth range)
    let sun_above = smoothstep(-0.4, 0.2, sun_height);
    
    // === DAY SKY ===
    // Atmospheric density increases towards horizon
    let atmosphere_density = 1.0 - pow(max(0.0, view_height), 0.4);
    
    // Zenith to horizon gradient with atmospheric scattering
    let horizon_blend = pow(smoothstep(-0.2, 0.6, view_height), 0.6);
    let day_sky_base = mix(SKY_HORIZON_DAY, SKY_ZENITH_DAY, horizon_blend);
    
    // Add subtle blue scattering (more blue when looking away from sun)
    let rayleigh = rayleigh_phase(cos_theta);
    let day_sky = day_sky_base * (0.8 + 0.2 * rayleigh);
    
    // === NIGHT SKY ===
    let night_horizon_blend = smoothstep(-0.3, 0.4, view_height);
    let night_sky = mix(NIGHT_HORIZON, NIGHT_ZENITH, night_horizon_blend);
    
    // === SUNSET/SUNRISE ===
    // Sunset is most vivid near horizon when sun is low
    let sunset_visibility = smoothstep(-0.3, 0.1, sun_height) * smoothstep(0.3, -0.1, sun_height);
    
    // Angular spread around sun (wider than actual sun)
    let sun_angle_influence = pow(max(0.0, cos_theta), 2.5);
    
    // Horizon glow (stronger near horizon)
    let horizon_factor = 1.0 - abs(view_height);
    let horizon_glow = pow(horizon_factor, 2.0);
    
    // Blend orange and pink for rich sunset
    let sunset_base = mix(SUNSET_ORANGE, SUNSET_PINK, pow(horizon_glow, 0.5));
    let sunset_contribution = sunset_base * sun_angle_influence * sunset_visibility * 2.5;
    
    // Wide atmospheric glow during sunset
    let atmospheric_sunset = SUNSET_ORANGE * horizon_glow * sunset_visibility * 0.8;
    
    // === COMPOSE SKY ===
    var sky_color = mix(night_sky, day_sky, sun_above);
    sky_color += sunset_contribution;
    sky_color += atmospheric_sunset;
    
    // === SUN DISK & HALO ===
    // Bright sun disk (only when sun is above horizon)
    let sun_disk = smoothstep(0.9996, 0.9999, cos_theta);
    let sun_contribution = SUN_COLOR * sun_disk * SUN_INTENSITY * max(0.0, sun_height);
    
    // Sun halo with smooth progressive falloff (tighter)
    let sun_halo_inner = pow(max(0.0, cos_theta), 32.0);  // Concentrated near sun
    let sun_halo_outer = pow(max(0.0, cos_theta), 32.0);   // Smooth transition
    let halo_contribution = SUN_COLOR * (sun_halo_inner * 0.4 + sun_halo_outer * 0.2) * max(0.0, sun_height);
    
    sky_color += sun_contribution + halo_contribution;
    
    return sky_color;
}

@fragment
fn fs(@location(0) position_clip: vec3<f32>) -> @location(0) vec4<f32> {
    var view_dir = get_view_dir(position_clip, camera);
    var world_dir = get_world_dir(view_dir, camera);
    world_dir = normalize(world_dir);
    
    let sun_dir = normalize(u_procedural.sunDirection);
    let sun_height = sun_dir.y;
    
    // Calculate moon direction (opposite to sun)
    let moon_dir = -sun_dir;
    let moon_height = moon_dir.y;
    
    // Night factor (0 = day, 1 = night)
    let night_factor = smoothstep(0.1, -0.2, sun_height);
    
    // Base atmospheric sky
    var sky_color = atmosphere_scattering(world_dir, sun_dir);
    
    // Add stars (only visible at night) — before clouds so they get occluded
    sky_color += generate_stars(world_dir, night_factor);
    
    // Add moon (only visible at night when moon is above horizon) — before clouds
    if (moon_height > 0.0) {
        sky_color += render_moon(world_dir, moon_dir, night_factor);
    }

    // Composite clouds on top (correctly occludes stars and moon)
    sky_color = render_clouds(world_dir, sun_dir, sky_color, night_factor, sun_height);
    
    return vec4<f32>(sky_color, 1.0);
}
