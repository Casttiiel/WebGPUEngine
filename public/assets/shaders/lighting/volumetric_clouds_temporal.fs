#include "common/uniforms"

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
    _pad0:        f32,
    _pad1:        f32,
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

    // ── 1. Current frame (bicubic upsample from 1/N res) ──────────────────────
    let current = sampleCurrentBicubic(uv);

    // ── 2. Camera reprojection via cloud mid-plane intersection ──────────────
    // Reconstruct the world-space ray for this pixel using the current frame's
    // inverse VP matrix.  Intersect with the horizontal cloud mid-plane (Y=cloudMid).
    // That world hit is then projected with the previous frame's VP to find the
    // history UV.  Works well for clouds because they are far and translational
    // parallax error (translation / cloudDist ≈ 0.1 %) is negligible.
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let wNear4 = camera.invViewProjection * vec4f(ndc, 0.0, 1.0);
    let wFar4  = camera.invViewProjection * vec4f(ndc, 1.0, 1.0);
    let wNear  = wNear4.xyz / wNear4.w;
    let wFar   = wFar4.xyz  / wFar4.w;
    let rayDir = normalize(wFar - wNear);
    let rayOri = camera.cameraPosition.xyz;

    // Only reproject if the ray and plane are not parallel (|dy| > ε) and the
    // intersection is in front of the camera (t > 0).
    let dy = rayDir.y;
    let t  = (temporal.cloudMid - rayOri.y) / dy;

    var historyColor = vec4f(0.0);
    var validHistory = false;

    if (abs(dy) > 0.0005 && t > 0.5) {
        let cloudHit = rayOri + rayDir * t;

        // Project hit into previous clip space
        let prevClip = temporal.prevViewProj * vec4f(cloudHit, 1.0);
        var prevNDC  = prevClip.xy / prevClip.w;
        var prevUV   = prevNDC * 0.5 + 0.5;
        prevUV.y     = 1.0 - prevUV.y;

        if (prevUV.x >= 0.001 && prevUV.x <= 0.999 &&
            prevUV.y >= 0.001 && prevUV.y <= 0.999) {
            historyColor = sampleHistoryCatmullRom(prevUV);
            // Treat history as valid only if it has any cloud data.
            validHistory = historyColor.a > 0.0002;
        }
    }

    if (!validHistory) {
        // No history available (first frame, disocclusion, or looking straight down).
        return current;
    }

    // ── 3. Neighbourhood variance clamp ──────────────────────────────────────
    // Sample the 3×3 neighbourhood in the low-res current texture.
    // Using low-res texel size so the kernel covers the equivalent 3 cloud texels
    // (= 3 × resolutionDivisor full-res pixels).  This gives enough neighbourhood
    // context to represent the local cloud colour range without over-expanding.
    var colorMin = vec4f( 1e9);
    var colorMax = vec4f(-1e9);
    let cDims   = vec2f(textureDimensions(currentTex));
    let cTexSz  = 1.0 / cDims;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let s = textureSampleLevel(currentTex, cloudSampler,
                        uv + vec2f(f32(x), f32(y)) * cTexSz, 0.0);
            colorMin = min(colorMin, s);
            colorMax = max(colorMax, s);
        }
    }
    // Slightly relax bounds to avoid over-clamping on cloud silhouette edges
    // where the neighbourhood mix of cloud/sky causes tight bounds.
    let slack  = (colorMax - colorMin) * 0.12;
    colorMin  -= slack;
    colorMax  += slack;

    let clampedHistory = clamp(historyColor, colorMin, colorMax);

    // ── 4. Temporal blend ─────────────────────────────────────────────────────
    // blendFactor ≈ 0.07 → 93 % history, 7 % current per frame.
    // At 60 fps a static cloud region converges fully in ~2 s.
    return mix(clampedHistory, current, temporal.blendFactor);
}
