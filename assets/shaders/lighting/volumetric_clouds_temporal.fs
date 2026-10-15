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


// ── Bindings ──────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var currentTex:   texture_2d<f32>;   // 1/N res ray march output
@group(1) @binding(1) var historyTex:   texture_2d<f32>;   // full-res previous resolved frame
@group(1) @binding(2) var cloudSampler: sampler;
@group(1) @binding(3) var<uniform> temporal: CloudTemporalUniforms;

struct CloudTemporalUniforms {
    prevViewProj: mat4x4f,  // previous frame view-projection (64 bytes)
    blendFactor:  f32,       // fraction of current frame to blend in (0.05–0.15)
    cloudMid:     f32,       // mid-altitude of cloud slab for ray-plane reprojection
    jitter:       vec2f,     // sub-pixel offset of the current ray-march frame (low-res pixels)
}

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

// ── B-spline bicubic upsample (current low-res → full-res) ───────────────────
fn bsplineWeights(f: f32) -> vec4f {
    let f2 = f * f;
    let f3 = f2 * f;
    return vec4f(
        (1.0 - 3.0*f  + 3.0*f2 - f3)      / 6.0,
        (4.0           - 6.0*f2 + 3.0*f3)  / 6.0,
        (1.0 + 3.0*f  + 3.0*f2 - 3.0*f3)  / 6.0,
        f3                                  / 6.0,
    );
}

fn sampleCurrentBicubic(uv: vec2f) -> vec4f {
    let dims    = vec2f(textureDimensions(currentTex));
    let invDims = 1.0 / dims;
    let tc = uv * dims - 0.5;
    let ti = floor(tc);
    let f  = tc - ti;
    let wx = bsplineWeights(f.x);
    let wy = bsplineWeights(f.y);
    let gx = vec2f(wx.x + wx.y, wx.z + wx.w);
    let gy = vec2f(wy.x + wy.y, wy.z + wy.w);
    let uvx = vec2f((ti.x - 0.5 + wx.y / gx.x) * invDims.x,
                    (ti.x + 1.5 + wx.w / gx.y) * invDims.x);
    let uvy = vec2f((ti.y - 0.5 + wy.y / gy.x) * invDims.y,
                    (ti.y + 1.5 + wy.w / gy.y) * invDims.y);
    return (textureSampleLevel(currentTex, cloudSampler, vec2f(uvx.x, uvy.x), 0.0) * gx.x
          + textureSampleLevel(currentTex, cloudSampler, vec2f(uvx.y, uvy.x), 0.0) * gx.y) * gy.x
         +(textureSampleLevel(currentTex, cloudSampler, vec2f(uvx.x, uvy.y), 0.0) * gx.x
          + textureSampleLevel(currentTex, cloudSampler, vec2f(uvx.y, uvy.y), 0.0) * gx.y) * gy.y;
}

// ── Catmull-Rom bicubic history sample (5-tap, minimises history blur) ────────
fn sampleHistoryCatmullRom(uv: vec2f) -> vec4f {
    let sz  = vec2f(textureDimensions(historyTex));
    let tsz = 1.0 / sz;
    let pos = uv * sz;
    let tc  = floor(pos - 0.5) + 0.5;
    let f   = pos - tc;
    let w0 = f * (-0.5 + f * ( 1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);
    let w12 = w1 + w2;
    let o12 = w2 / w12;
    let uv0  = (tc - 1.0) * tsz;
    let uv3  = (tc + 2.0) * tsz;
    let uv12 = (tc + o12) * tsz;
    var s = vec4f(0.0);
    s += textureSampleLevel(historyTex, cloudSampler, vec2f(uv12.x, uv0.y),  0.0) * (w12.x * w0.y );
    s += textureSampleLevel(historyTex, cloudSampler, vec2f(uv0.x,  uv12.y), 0.0) * (w0.x  * w12.y);
    s += textureSampleLevel(historyTex, cloudSampler, vec2f(uv12.x, uv12.y), 0.0) * (w12.x * w12.y);
    s += textureSampleLevel(historyTex, cloudSampler, vec2f(uv3.x,  uv12.y), 0.0) * (w3.x  * w12.y);
    s += textureSampleLevel(historyTex, cloudSampler, vec2f(uv12.x, uv3.y),  0.0) * (w12.x * w3.y );
    return s;
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    let uv = vec2f(in.position_clip.x * 0.5 + 0.5, 0.5 - in.position_clip.y * 0.5);

    // ── 1. Current frame, un-jittered ────────────────────────────────────────
    // Low-res texel i was ray-marched at (i + 0.5 + jitter) / dims, so this
    // full-res pixel's ray lands at texel coordinate uv·dims − jitter.
    let cDims    = vec2f(textureDimensions(currentTex));
    let cTexSz   = 1.0 / cDims;
    let uvCur    = uv - temporal.jitter * cTexSz;
    let current  = textureSampleLevel(currentTex, cloudSampler, uvCur, 0.0);

    // Distance (in low-res texels) from this pixel to the closest real sample:
    // pixels that a sample hit exactly this frame take more of the new value.
    let tc         = uvCur * cDims;
    let dSample    = length(tc - (floor(tc) + 0.5));
    let sampleW    = exp(-4.0 * dSample * dSample);   // 1 on the sample, ≈0.14 at the corner

    // ── 2. Camera reprojection via cloud mid-plane intersection ──────────────
    // Same ray reconstruction as the ray-march pass (projection-matrix based,
    // valid with reverse-Z / infinite far plane).  The world hit is projected
    // with the previous frame's VP to find the history UV.
    let rayDir = normalize(get_world_dir(get_view_dir(in.position_clip, camera), camera));
    let rayOri = camera.cameraPosition.xyz;

    let dy = rayDir.y;
    let t  = (temporal.cloudMid - rayOri.y) / dy;

    var historyColor = vec4f(0.0);
    var validHistory = false;

    if (abs(dy) > 0.0005 && t > 0.5) {
        let cloudHit = rayOri + rayDir * t;

        let prevClip = temporal.prevViewProj * vec4f(cloudHit, 1.0);
        if (prevClip.w > 0.0) {
            var prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
            prevUV.y   = 1.0 - prevUV.y;

            if (prevUV.x >= 0.001 && prevUV.x <= 0.999 &&
                prevUV.y >= 0.001 && prevUV.y <= 0.999) {
                historyColor = sampleHistoryCatmullRom(prevUV);
                validHistory = true;
            }
        }
    }

    if (!validHistory) {
        // No history (first frame, off-screen, looking along the plane):
        // smooth B-spline upsample hides the low-res grid.
        return sampleCurrentBicubic(uvCur);
    }

    // ── 3. Neighbourhood clamp (3×3 low-res texels around the un-jittered UV) ─
    var colorMin = vec4f( 1e9);
    var colorMax = vec4f(-1e9);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let s = textureSampleLevel(currentTex, cloudSampler,
                        uvCur + vec2f(f32(x), f32(y)) * cTexSz, 0.0);
            colorMin = min(colorMin, s);
            colorMax = max(colorMax, s);
        }
    }
    // Slightly relax bounds to avoid over-clamping on silhouettes.
    let slack  = (colorMax - colorMin) * 0.12;
    colorMin  -= slack;
    colorMax  += slack;

    let clampedHistory = clamp(max(historyColor, vec4f(0.0)), colorMin, colorMax);

    // ── 4. Temporal blend ─────────────────────────────────────────────────────
    // blendFactor is the average weight; pixels right on this frame's sample
    // get up to 2.25×, pixels between samples ≈0.5× — sub-pixel detail from the
    // jitter pattern accumulates instead of being smeared by the upsample.
    let alpha = saturate(temporal.blendFactor * (0.25 + 2.0 * sampleW));
    return mix(clampedHistory, current, alpha);
}
