#include "common/uniforms"
#include "common/math/coordinates"

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
