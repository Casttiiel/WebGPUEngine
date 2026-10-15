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


// ─── God Rays Bilateral Blur ──────────────────────────────────────────────────
//
// Separable depth-aware Gaussian over the half-res volumetric buffer.
// Run twice (horizontal, then vertical). Taps whose depth differs from the
// centre are rejected, so the raymarch noise is smoothed without smearing
// shafts across geometry edges (unlike a plain Kawase/box blur).
//
// Input/output layout: r = scatter, g = normalized linear depth (passed through).
//
// Bind-group layout
//   group(0)  CameraUniforms              (standard engine binding)
//   group(1)  Input texture + sampler     (SingleTexture)
//   group(2)  BlurParams uniform          (KawaseUniforms — 16-byte uniform)

// 16 bytes — 4 × f32.
struct BlurParams {
    dirX:       f32,  // texel step direction (1,0) or (0,1)
    dirY:       f32,
    depthSigma: f32,  // relative depth tolerance (e.g. 0.05 = 5 %)
    _pad0:      f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

@group(2) @binding(0) var<uniform> params: BlurParams;

const RADIUS: i32 = 4;
const SPATIAL_SIGMA: f32 = 2.5;

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<i32>(textureDimensions(inputTexture));
    let c = vec2<i32>(fragCoord.xy);
    let center = textureLoad(inputTexture, c, 0);
    let centerDepth = center.g;
    let dir = vec2<i32>(i32(params.dirX), i32(params.dirY));

    let invSpatial = 1.0 / (2.0 * SPATIAL_SIGMA * SPATIAL_SIGMA);
    let invDepth = 1.0 / (2.0 * params.depthSigma * params.depthSigma);

    var sum = 0.0;
    var wSum = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i++) {
        let p = clamp(c + dir * i, vec2<i32>(0), dims - 1);
        let s = textureLoad(inputTexture, p, 0);
        let dz = (s.g - centerDepth) / max(centerDepth, 1e-4);
        let fi = f32(i);
        let w = exp(-fi * fi * invSpatial) * exp(-dz * dz * invDepth);
        sum += s.r * w;
        wSum += w;
    }

    // The centre tap always has weight 1, so wSum >= 1.
    return vec4<f32>(sum / wSum, centerDepth, 0.0, 1.0);
}
