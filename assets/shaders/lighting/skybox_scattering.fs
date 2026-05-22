struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

// Coordinate transformation utilities
// Level 1: Depends on core/constants, core/uniforms

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

// Basic math utility functions
// Level 0: No dependencies

// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}


// Reconstruct world position from UV, depth, and camera
fn getWorldCoords(uv: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
    // Convert UV coordinates (0-1) to NDC coordinates (-1 to 1)
    let coords = vec2<f32>(uv.x, 1.0 - uv.y);
    let ndc_coords = (coords * 2.0) - 1.0;
    
    // Get the ray direction by transforming NDC coordinates
    let near_ndc = vec4<f32>(ndc_coords.x, ndc_coords.y, 1.0, 1.0);
    let near_world_homogeneous = camera.invViewProjection * near_ndc;
    let near_world = near_world_homogeneous.xyz / near_world_homogeneous.w;

    // Calculate the ray direction from camera to the point (in WORLD coordinates)
    let ray_direction = normalize(near_world - camera.cameraPosition.xyz);
    
    // zlinear was calculated as: dot(worldPos - cameraPos, cameraFront) / zFar
    // So: distance_along_front = zlinear * zFar
    // But we need distance_along_ray = distance_along_front / dot(ray_direction, cameraFront)
    let distance_along_front = zlinear * camera.cameraFar;
    let distance_along_ray = distance_along_front / dot(ray_direction, camera.cameraFront.xyz);
    
    // Calculate final world position
    return camera.cameraPosition.xyz + ray_direction * distance_along_ray;
}

// Get view space direction from clip space position
fn get_view_dir(clip_pos: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Extract FOV and aspect ratio from projection matrix
    let fov = atan(1.0 / camera.projectionMatrix[1][1]);
    let aspect = camera.projectionMatrix[1][1] / camera.projectionMatrix[0][0];
    
    // Reconstruct view space direction
    var view_dir = vec3<f32>(
        clip_pos.x * tan(fov) * aspect,
        clip_pos.y * tan(fov),
        -1.0
    );
    
    return normalize(view_dir);
}

// Transform view space direction to world space
fn get_world_dir(view_dir: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Inverse rotation = transpose of upper 3x3 view matrix
    let rotation = transpose(mat3x3<f32>(
        camera.viewMatrix[0].xyz,
        camera.viewMatrix[1].xyz,
        camera.viewMatrix[2].xyz
    ));
    
    return rotation * view_dir;
}

// Convert 3D direction to equirectangular UV coordinates
fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
    let theta = atan2(dir.x, dir.z); // [-PI, PI]
    let phi = acos(clamp(dir.y, -1.0, 1.0)); // [0, PI]
    let u = (theta + PI) / TWO_PI; // [0, 1]
    let v = phi / PI; // [0, 1]
    return vec2<f32>(u, v);
}


// Procedural skybox uniforms
struct SkyboxProceduralUniforms {
  sunDirection: vec3<f32>,    // Real sun direction (for scattering)
  timeOfDay: f32,             // Time of day [0, 1]         | offset 12
  windDirection: vec2<f32>,   // Normalized XZ wind direction | offset 16
  cloudThickness: f32,        // Cloud density multiplier     | offset 24
  cloudDistanceFade: f32,     // Elevation at which clouds fully appear | offset 28
  windOffset: f32,            // Accumulated wind displacement | offset 32
  cloudScale: f32,            // Cloud size (1=default, >1=bigger clouds) | offset 36
  cloudCoverage: f32,         // Cloud coverage [0=sparse, 1=overcast]  | offset 40
  cloudOpacity: f32,          // Max cloud opacity [0..1]               | offset 44
  cloudLayers: f32,           // FBM octave count [1..8]                | offset 48
  cloudColorR: f32,           // Cloud tint red   [0..1]                | offset 52
  cloudColorG: f32,           // Cloud tint green [0..1]                | offset 56
  cloudColorB: f32,           // Cloud tint blue  [0..1]                | offset 60 → 64 bytes
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
// Cloud rendering — double domain-warped FBM + edge-lit density shading
// ─────────────────────────────────────────────────────────────────────────────

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x),
        mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x),
        u.y
    );
}

// Cheap 2-octave FBM for domain warp passes (fixed cost)
fn fbm2(p: vec2<f32>) -> f32 {
    return value_noise(p) * 0.5 + value_noise(p * 2.1) * 0.25;
}

// FBM with variable octave count
fn fbm_n(p: vec2<f32>, octaves: i32) -> f32 {
    var v = 0.0;
    var amp = 0.5;
    var freq = 1.0;
    for (var i = 0; i < octaves; i++) {
        v += amp * value_noise(p * freq);
        amp  *= 0.5;
        freq *= 2.1;
    }
    return v;
}

// Double domain warping: two chained UV perturbation passes.
// Pass 1 stretches noise into large organic masses.
// Pass 2 adds medium-scale turbulence that breaks up any regularity.
// Result: highly irregular, non-repeating cloud shapes without circular Worley blobs.
fn cloud_density_at(uv: vec2<f32>, octaves: i32) -> f32 {
    let w1 = vec2f(fbm2(uv + vec2f(1.7, 9.2)),
                   fbm2(uv + vec2f(8.3, 2.8))) * 1.4;
    let p1 = uv + w1;

    let w2 = vec2f(fbm2(p1 + vec2f(3.1, 5.4)),
                   fbm2(p1 + vec2f(7.2, 1.6))) * 0.6;
    let p2 = p1 + w2;

    return fbm_n(p2, octaves);
}

// Composites procedural clouds onto an existing sky color.
fn render_clouds(
    world_dir: vec3<f32>,
    sun_dir: vec3<f32>,
    sky_color: vec3<f32>,
    night_factor: f32,
    sun_height: f32,
) -> vec3<f32> {
    if (world_dir.y <= 0.001) {
        return sky_color;
    }

    // Planar UV. cloudScale >1 → bigger/fewer clouds (lower UV frequency)
    var uv = world_dir.xz / world_dir.y;
    uv += u_procedural.windDirection * u_procedural.windOffset;
    uv = uv * (1.5 / max(u_procedural.cloudScale, 0.01)) + vec2f(47.3, 31.7);

    let octaves = i32(clamp(u_procedural.cloudLayers, 1.0, 8.0));

    // Coverage: 0=sparse, 1=overcast
    let threshold     = 0.50 * (1.0 - clamp(u_procedural.cloudCoverage, 0.0, 1.0));
    let raw           = cloud_density_at(uv, octaves);
    let cloud_density = saturate((raw - threshold) * u_procedural.cloudThickness);

    // Horizon fade to hide UV singularity stretching near equator
    let horizon_fade  = smoothstep(0.0, u_procedural.cloudDistanceFade, world_dir.y);
    let final_density = cloud_density * horizon_fade;

    if (final_density < 0.001) {
        return sky_color;
    }

    // Edge-lit density shading:
    // Low density (cloud edges) → fully lit bright white.
    // High density (cloud interior) → darker, simulates light attenuation through thickness.
    let cloud_day   = vec3f(0.96, 0.97, 1.00);
    let cloud_night = vec3f(0.03, 0.04, 0.09);
    var cloud_lit   = mix(cloud_night, cloud_day, 1.0 - night_factor);

    let interior     = final_density * final_density;
    let shadow_color = cloud_lit * vec3f(0.45, 0.48, 0.58);
    var cloud_color  = mix(cloud_lit, shadow_color, interior * 0.70);

    // Sunset tint on sun-facing clouds
    let cos_to_sun    = dot(normalize(world_dir), sun_dir);
    let sunset_window = smoothstep(-0.3, 0.1, sun_height) * smoothstep(0.3, -0.1, sun_height);
    let sunset_cloud  = saturate(sunset_window * max(0.0, cos_to_sun));
    cloud_color = mix(cloud_color, SUNSET_ORANGE * 0.75, sunset_cloud);

    // User color tint (0-1, white = no tint, dark gray = storm/rain)
    let cloud_tint = vec3f(u_procedural.cloudColorR, u_procedural.cloudColorG, u_procedural.cloudColorB);
    cloud_color = cloud_color * cloud_tint;

    return mix(sky_color, cloud_color, final_density * clamp(u_procedural.cloudOpacity, 0.0, 1.0));
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
