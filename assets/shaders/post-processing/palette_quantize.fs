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


// PSX-style color palette quantization with Bayer ordered dithering.
// Reduces the frame to a limited number of colors per channel
// (default: 5 levels × 5 × 5 = 125 ≈ 128 colors) using the
// classic Bayer 4×4 matrix to dither between quantization steps.
//
// Bind-group layout:
//   group(0)  CameraUniforms     (screenSize used for pixel coordinates)
//   group(1)  input texture + sampler + params uniform

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;
@group(1) @binding(2) var<uniform> params: PaletteQuantizeParams;

struct PaletteQuantizeParams {
    levels:         f32,  // quantization levels per channel (5 → 5³=125 colors)
    ditherStrength: f32,  // 0 = no dither (hard bands), 1 = full Bayer dither
    enabled:        f32,  // 0 = pass-through
    _pad:           f32,
}

// Bayer 4×4 ordered dither matrix.
// Each value ÷ 16 gives a threshold in [0, 1) that tiles perfectly at 4-pixel intervals.
fn bayer4(coord: vec2<u32>) -> f32 {
    let b = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0,
    );
    return b[(coord.x % 4u) + (coord.y % 4u) * 4u] / 16.0;
}

// Quantize `c` to `levels` evenly-spaced values in [0, 1].
// With levels=5: outputs 0, 0.25, 0.50, 0.75, 1.00.
fn quantize(c: vec3<f32>, levels: f32) -> vec3<f32> {
    let L = levels - 1.0;
    return floor(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * L + 0.5) / L;
}

@fragment
fn fs(@location(0) uv: vec2<f32>, @builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(inputTexture, inputSampler, uv).rgb;

    if (params.enabled < 0.5) {
        return vec4<f32>(color, 1.0);
    }

    // Use the exact fragment position (pixel-center coordinates) for the Bayer
    // lookup instead of uv * screenSize. UV interpolation across the two
    // fullscreen-quad triangles introduces sub-pixel error at the center seam
    // (x=0.5) that shifts the Bayer pattern by 1px → visible bright vertical line.
    // @builtin(position) is always exact: (0.5, 1.5, 2.5, …) → u32 truncation is safe.
    let pixCoord = vec2<u32>(fragPos.xy);
    let dither    = bayer4(pixCoord);

    // Mix neutral threshold (0.5 = round-to-nearest) with Bayer offset.
    // ditherStrength=0 → pure rounding (hard bands).
    // ditherStrength=1 → full Bayer dithering (PSX-style noise on gradients).
    let threshold  = mix(0.5, dither, params.ditherStrength);
    let L          = params.levels - 1.0;
    let dithered   = clamp(color + (threshold - 0.5) / L, vec3<f32>(0.0), vec3<f32>(1.0));
    let quantized  = floor(dithered * L + 0.5) / L;

    return vec4<f32>(quantized, 1.0);
}
