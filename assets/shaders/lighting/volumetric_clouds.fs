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



// ── Cloud uniforms ─────────────────────────────────────────────────────────────
struct CloudUniforms {
    sunDirection:    vec3f,  // offset   0
    cloudBase:       f32,    // offset  12 → 16
    sunColor:        vec3f,  // offset  16
    cloudTop:        f32,    // offset  28 → 32
    windDirection:   vec3f,  // offset  32
    windOffset:      f32,    // offset  44 → 48
    coverage:        f32,    // offset  48
    density:         f32,    // offset  52
    absorption:      f32,    // offset  56
    scatterStrength: f32,    // offset  60 → 64
    ambientColor:    vec3f,  // offset  64
    cloudFrequency:  f32,    // offset  76 → 80
    stepCount:       f32,    // offset  80
    lightSteps:      f32,    // offset  84
    warpStrength:    f32,    // offset  88
    worleyWeight:    f32,    // offset  92
    fadeRadius:      f32,    // offset  96
    frameIndex:      f32,    // offset 100
    jitter:          vec2f,  // offset 104 — sub-pixel offset of this frame's ray (low-res pixels)
    resolution:      vec2f,  // offset 112 — low-res target size
    detailStrength:  f32,    // offset 120
    detailFrequency: f32,    // offset 124 → 128 — detail noise frequency relative to the shape
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> u_cloud: CloudUniforms;
// Baked, tileable noise (see volumetric_clouds_noise.compute.wgsl). Sampled with 'repeat'.
@group(1) @binding(1) var shapeTex:     texture_3d<f32>;  // R perlin fBm, GBA inverted worley fBm (low/mid/high)
@group(1) @binding(2) var detailTex:    texture_3d<f32>;  // RGB inverted worley fBm (edge erosion)
@group(1) @binding(3) var weatherTex:   texture_2d<f32>;  // R regional coverage, G per-column top height
@group(1) @binding(4) var noiseSampler: sampler;

// Noise-space size of each texture tile (must match the bake periods).
//   shape:   4 base cells per tile  → 1 noise unit per cell
//   detail:  2 base cells per tile, u_cloud.detailFrequency× finer than the shape
//   weather: 4 cells per tile at 0.5× (coverage), 12 cells at 1.5× (top height)
const SHAPE_TILE:   f32 = 4.0;
const DETAIL_TILE:  f32 = 2.0;
const WEATHER_TILE: f32 = 8.0;

// ── Math helpers ───────────────────────────────────────────────────────────────

fn remap(v: f32, inLo: f32, inHi: f32, outLo: f32, outHi: f32) -> f32 {
    return outLo + saturate((v - inLo) / (inHi - inLo)) * (outHi - outLo);
}

fn rayPlaneIntersect(ro: vec3f, rd: vec3f, planeY: f32) -> f32 {
    if (abs(rd.y) < 0.0001) { return -1e9; }
    return (planeY - ro.y) / rd.y;
}

// ── Interleaved Gradient Noise, rotated every frame ───────────────────────────
// The temporal resolve integrates the per-frame offsets, so each pixel converges
// to the average over many ray start positions instead of one fixed slice.
fn ign(coord: vec2f, frame: f32) -> f32 {
    let c = coord + 5.588238 * (frame % 64.0);
    return fract(52.9829189 * fract(0.06711056 * c.x + 0.00583715 * c.y));
}

// ── Cloud density ──────────────────────────────────────────────────────────────

fn windOffset3() -> vec3f {
    return vec3f(u_cloud.windDirection.x, 0.0, u_cloud.windDirection.z) * u_cloud.windOffset;
}

// x: regional density scale [0.55, 1.45], y: per-column top fraction [0.28, 0.80]
fn sampleWeather(pos: vec3f) -> vec2f {
    let p  = (pos.xz + windOffset3().xz) * u_cloud.cloudFrequency;
    let w  = textureSampleLevel(weatherTex, noiseSampler, p / WEATHER_TILE, 0.0);
    let cov = saturate((w.r - 0.2) / 0.6);
    let top = saturate((w.g - 0.15) / 0.7);
    return vec2f(0.55 + cov * 0.9, 0.28 + top * 0.52);
}

fn heightGradient(hFrac: f32, topFrac: f32) -> f32 {
    // Bottom: tendril zone from -0.12 to 0.20 above cloudBase.
    // Top: variable per column — fades from topFrac to topFrac + 0.18.
    return smoothstep(-0.12, 0.20, hFrac) * smoothstep(topFrac + 0.18, topFrac, hFrac);
}

// Single density function shared by the view march and the light march, so
// self-shadowing is cast by the same shape that is drawn.  `detailAmount` fades
// the high-frequency erosion out continuously with distance (no LOD tiers).
fn sampleDensity(pos: vec3f, detailAmount: f32) -> f32 {
    let cloudH  = u_cloud.cloudTop - u_cloud.cloudBase;
    let hFrac   = (pos.y - u_cloud.cloudBase) / cloudH;
    let weather = sampleWeather(pos);
    let grad    = heightGradient(hFrac, weather.y);
    if (grad < 0.001) { return 0.0; }

    // evol: slow evolution — shapes mutate over minutes, imperceptible frame to frame.
    let evol = u_cloud.windOffset * 0.0001;
    let p    = (pos + windOffset3()) * u_cloud.cloudFrequency + vec3f(0.0, evol, 0.0);

    // Domain warp: one fetch of the shape texture at 1/8 frequency.  Its three
    // channels are decorrelated noises, drifting at their own rate.
    let warpS = textureSampleLevel(shapeTex, noiseSampler,
                                   (p * 0.125 + vec3f(evol * 0.71, 0.37, -evol * 1.37)) / SHAPE_TILE, 0.0);
    let warp  = (warpS.rgb - 0.5) * 2.0 * u_cloud.warpStrength;

    // Base shape: Perlin-Worley, eroded by the low-frequency Worley fBm (Nubis).
    let s     = textureSampleLevel(shapeTex, noiseSampler, (p + warp) / SHAPE_TILE, 0.0);
    let pw    = mix(s.r, s.g, u_cloud.worleyWeight);
    let wfbm  = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
    let base  = remap(pw, wfbm - 1.0, 1.0, 0.0, 1.0);

    // Coverage threshold is uniform — clouds exist everywhere, only thickness varies.
    // Calibrated against the baked noise distribution: 0.58 ≈ scattered cumulus, 1 ≈ overcast.
    let threshold = mix(0.72, 0.46, u_cloud.coverage);
    let rawShape  = remap(base, threshold, 1.0, 0.0, 1.0);
    var density   = pow(rawShape, 1.3) * grad * weather.x;
    if (density < 0.001) { return 0.0; }

    // Edge erosion with the detail texture.  It drifts faster than the base shape
    // and rises slowly, so edges boil and curl while the cloud body moves.
    if (detailAmount > 0.001) {
        let pd = (pos + windOffset3() * 1.4) * u_cloud.cloudFrequency * u_cloud.detailFrequency
               + vec3f(0.0, -evol * 30.0, 0.0);
        let d    = textureSampleLevel(detailTex, noiseSampler, pd / DETAIL_TILE, 0.0);
        let dfbm = d.r * 0.625 + d.g * 0.25 + d.b * 0.125;
        // Wispy (cell borders) near the base, billowy (cell centres) higher up.
        let erosion    = mix(dfbm, 1.0 - dfbm, saturate(hFrac * 4.0));
        let edgeFactor = saturate(1.0 - density / 0.35);
        density       -= edgeFactor * erosion * u_cloud.detailStrength * detailAmount;
    }

    return max(0.0, density) * u_cloud.density;
}

// ── Lighting ───────────────────────────────────────────────────────────────────

// Light march towards the sun with geometrically growing steps: dense sampling
// near the point (where self-shadow detail matters) and long steps further away.
fn sampleLighting(pos: vec3f, nSteps: i32) -> f32 {
    let tExit     = rayPlaneIntersect(pos, u_cloud.sunDirection, u_cloud.cloudTop);
    let marchDist = clamp(tExit, 0.0, (u_cloud.cloudTop - u_cloud.cloudBase) * 2.0);
    if (marchDist < 0.001) { return 1.0; }

    let ratio    = 1.6;
    var stepSize = marchDist * (ratio - 1.0) / (pow(ratio, f32(nSteps)) - 1.0);
    var t        = 0.0;
    var accumulated = 0.0;
    for (var i = 0; i < 12; i++) {
        if (i >= nSteps) { break; }
        accumulated += sampleDensity(pos + u_cloud.sunDirection * (t + stepSize * 0.5), 0.0) * stepSize;
        t        += stepSize;
        stepSize *= ratio;
    }
    let od = accumulated * u_cloud.absorption;
    // Multiple scattering approximation: primary Beer-Lambert term (direct) +
    // a low-absorption term (simulates light bouncing back from deeper cloud layers).
    return exp(-od) * 0.7 + exp(-od * 0.25) * 0.3;
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (pow(max(0.001, 1.0 + g2 - 2.0 * g * cosTheta), 1.5) * (4.0 * PI));
}

fn dualLobe(cosTheta: f32) -> f32 {
    return mix(henyeyGreenstein(cosTheta, 0.8), henyeyGreenstein(cosTheta, -0.3), 0.5);
}

fn powderEffect(density: f32, cosTheta: f32) -> f32 {
    let powder = 1.0 - exp(-density * 2.0);
    return mix(1.0, powder, saturate(-cosTheta * 0.5 + 0.5));
}

// ── Main ray march ─────────────────────────────────────────────────────────────

fn marchClouds(rayOrigin: vec3f, rayDir: vec3f, dither: f32) -> vec4f {
    // Extend the effective slab bottom 12 % below cloudBase so the march enters
    // the tendril zone defined in heightGradient (smoothstep -0.12 → 0.20).
    let cloudH  = u_cloud.cloudTop - u_cloud.cloudBase;
    let extBase = u_cloud.cloudBase - cloudH * 0.12;

    let cameraInSlab = rayOrigin.y >= extBase && rayOrigin.y <= u_cloud.cloudTop;

    let tBase = rayPlaneIntersect(rayOrigin, rayDir, extBase);
    let tTop  = rayPlaneIntersect(rayOrigin, rayDir, u_cloud.cloudTop);

    var tStart = 0.0;
    var tEnd   = 0.0;

    if (cameraInSlab) {
        tStart = 0.0;
        tEnd   = max(0.0, max(tBase, tTop));
        if (tEnd < 0.001) { return vec4f(0.0); }
    } else {
        // Camera outside the slab: only positive t values are valid.
        let tA = select(-1.0, tBase, tBase >= 0.0);
        let tB = select(-1.0, tTop,  tTop  >= 0.0);
        if (tA < 0.0 && tB < 0.0) { return vec4f(0.0); }
        tStart = select(tB, min(tA, tB), tA >= 0.0 && tB >= 0.0);
        tEnd   = max(tA, tB);
    }

    if (tEnd <= tStart) { return vec4f(0.0); }

    let horizLen = length(rayDir.xz);
    if (tStart * horizLen >= u_cloud.fadeRadius) { return vec4f(0.0); }

    let cosTheta = dot(rayDir, u_cloud.sunDirection);
    let phase    = dualLobe(cosTheta);

    let nSteps      = i32(clamp(u_cloud.stepCount, 16.0, 128.0));
    let nLightSteps = i32(clamp(u_cloud.lightSteps, 2.0, 12.0));

    // Step size: min of splitting the ray in nSteps and cloudH/16 along the vertical,
    // so grazing rays do not take huge steps that jump over whole clouds.
    let vertComp = max(abs(rayDir.y), 0.08);
    let maxStep  = cloudH / (16.0 * vertComp);
    let baseStep = min((tEnd - tStart) / f32(nSteps), maxStep);

    // Constant terms of the ambient light (only hFrac varies per step).
    let sunHCl     = max(0.0, u_cloud.sunDirection.y);
    let groundTint = vec3f(0.6 + sunHCl * 0.3, 0.5 + sunHCl * 0.2, 0.3 + sunHCl * 0.1);

    var transmittance    = 1.0;
    var scatteredLight   = vec3f(0.0);
    var consecutiveEmpty = 0;
    var t     = tStart + baseStep * dither;
    var iters = 0;

    loop {
        if (t >= tEnd || iters >= 256 || transmittance < 0.01) { break; }
        iters++;

        let stepHorizDist = t * horizLen;

        // Per-step fade: extinction reduces smoothly from 55 % to 100 % of fadeRadius.
        let stepFade = 1.0 - saturate((stepHorizDist - u_cloud.fadeRadius * 0.55)
                                      / (u_cloud.fadeRadius * 0.45));
        if (stepFade <= 0.001) { break; }

        // Detail erosion fades continuously between 35 % and 65 % of fadeRadius.
        let detailAmount = 1.0 - smoothstep(u_cloud.fadeRadius * 0.35,
                                            u_cloud.fadeRadius * 0.65, stepHorizDist);

        let pos     = rayOrigin + rayDir * t;
        let density = sampleDensity(pos, detailAmount);

        if (density > 0.001) {
            // Came in with a long (2×) step: back up one step so the cloud edge is
            // sampled at full resolution instead of being skipped.
            if (consecutiveEmpty >= 2) {
                consecutiveEmpty = 0;
                t -= baseStep;
                continue;
            }
            consecutiveEmpty = 0;

            let extinction     = density * u_cloud.absorption * stepFade;
            let stepT          = exp(-extinction * baseStep);
            let stepAbsorption = 1.0 - stepT;

            let lightEnergy = sampleLighting(pos, nLightSteps);
            let powder      = powderEffect(density, cosTheta);

            scatteredLight += transmittance * lightEnergy * phase * powder
                            * u_cloud.sunColor * stepAbsorption * u_cloud.scatterStrength;

            let hFrac      = (pos.y - u_cloud.cloudBase) / cloudH;
            let skyAmbient = u_cloud.ambientColor * (0.3 + 0.7 * hFrac);
            let gndAmbient = u_cloud.ambientColor * groundTint * (1.0 - hFrac) * 0.15;
            scatteredLight += transmittance * (skyAmbient + gndAmbient) * stepAbsorption * stepFade * 0.5;

            transmittance *= stepT;
            t += baseStep;
        } else {
            // Empty space: up to 2× steps (backed up on the next hit, see above).
            consecutiveEmpty++;
            t += baseStep * f32(min(consecutiveEmpty, 2));
        }
    }

    return vec4f(scatteredLight, (1.0 - transmittance));
}

// ── Fragment entry ─────────────────────────────────────────────────────────────

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    // Sub-pixel jitter (Halton, changes every frame): over N frames each low-res
    // texel covers N different rays, which the temporal resolve accumulates into
    // a full-resolution result.  Pixel y grows downwards, clip y upwards.
    let jitterClip = vec2f(u_cloud.jitter.x, -u_cloud.jitter.y) * 2.0 / u_cloud.resolution;
    let clipPos    = vec3f(in.position_clip.xy + jitterClip, in.position_clip.z);

    let viewDir   = get_view_dir(clipPos, camera);
    let worldDir  = normalize(get_world_dir(viewDir, camera));
    let rayOrigin = camera.cameraPosition.xyz;

    let dither = ign(in.fragCoord.xy, u_cloud.frameIndex);

    return marchClouds(rayOrigin, worldDir, dither);
}
