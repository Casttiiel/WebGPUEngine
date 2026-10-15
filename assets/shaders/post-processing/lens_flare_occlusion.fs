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


// ─── Lens Flare Occlusion Mask ───────────────────────────────────────────────
//
// Step 1 of the screen-space lens flare pipeline.
//
// Renders a quarter-resolution sky-visibility mask:
//   - Sky pixels near the sun (linearDepth ≈ 1.0) → white
//   - Geometry occluders                           → black
//
// The result is sampled in Step 2 around the sun UV to compute
// how much of the sun disc is visible (occlusion factor [0,1]).
//
// Bind-group layout
//   group(0)  CameraUniforms
//   group(1)  GBufferUniforms  (albedo, normals, linearDepth, sampler)
//   group(2)  LensFlareParams uniform  (GodRaysUniforms layout — single UBO)

// ─── Params struct ────────────────────────────────────────────────────────────
// 8 × f32 = 32 bytes
struct LensFlareParams {
    sunNdcX:    f32,  // Sun X in NDC [-1, 1]
    sunNdcY:    f32,  // Sun Y in NDC [-1, 1]
    intensity:  f32,  // Flare intensity
    enabled:    f32,  // 0 = skip, 1 = active
    sunR:       f32,  // Sun color R
    sunG:       f32,  // Sun color G
    sunB:       f32,  // Sun color B
    ghostScale: f32,  // Ghost element size factor
}

// ─── Bind groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: LensFlareParams;

// ─── Fragment entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.enabled < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sun position in UV space.
    let sunUV = vec2<f32>(
        params.sunNdcX *  0.5 + 0.5,
        params.sunNdcY * -0.5 + 0.5,
    );

    // Aspect-corrected distance from current fragment to sun.
    let aspect = camera.screenSize.x / camera.screenSize.y;
    let diff = (uv - sunUV) * vec2<f32>(aspect, 1.0);
    let dist = length(diff);

    // Only write within a radius around the sun disc.
    // Beyond this radius the occlusion mask is black (no flare contribution).
    let OCC_RADIUS: f32 = 0.07;
    if (dist > OCC_RADIUS) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Geometry test: use textureLoad (nearest-neighbor, no bilinear) so wall/sky
    // boundary pixels are never falsely blended to depth >= 1.0.  Bilinear sampling
    // at grazing angles produces averaged depth values that can exceed 0.9999 even
    // for solid geometry, causing the flare to leak through walls.
    let texDims  = textureDimensions(gLinearDepth);
    let texCoord = clamp(
        vec2<i32>(vec2<f32>(texDims) * uv),
        vec2<i32>(0),
        vec2<i32>(texDims) - vec2<i32>(1),
    );
    let linearDepth = textureLoad(gLinearDepth, texCoord, 0).r;
    if (linearDepth < 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Sky pixel inside sun disc → white, with smooth falloff toward rim.
    let mask = 1.0 - smoothstep(OCC_RADIUS * 0.5, OCC_RADIUS, dist);
    return vec4<f32>(mask, mask, mask, 1.0);
}
