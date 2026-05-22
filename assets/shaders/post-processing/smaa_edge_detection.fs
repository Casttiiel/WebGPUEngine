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


// -----------------------------------------------------------------------------
// SMAA Edge Detection Pass (WGSL) — Accurate SMAA 1x Implementation
// Based on: "Enhanced Subpixel Morphological Antialiasing" - Jimenez et al.
// -----------------------------------------------------------------------------

struct SMAAParams {
    threshold: f32,  // 0.05–0.15 typical
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: SMAAParams;


// Edge detection function
fn colorEdgeDetection(uv: vec2<f32>, offset: array<vec4<f32>, 3>) -> vec2<f32> {
    let c = textureSample(colorTex, colorSampler, uv).rgb;

    // Neighbors
    let cL = textureSample(colorTex, colorSampler, offset[0].xy).rgb;
    var t = abs(c - cL);
    let deltaX = max(max(t.r, t.g), t.b);

    let cT = textureSample(colorTex, colorSampler, offset[0].zw).rgb;
    t = abs(c - cT);
    let deltaY = max(max(t.r, t.g), t.b);

    var edges = vec2<f32>(step(params.threshold, deltaX), step(params.threshold, deltaY));

    // Then discard if there is no edge:
    if (dot(edges, vec2<f32>(1.0)) == 0.0) {
        return vec2<f32>(0.0);
    }

    let cR = textureSampleLevel(colorTex, colorSampler, offset[1].xy, 0.0).rgb;
    t = abs(c - cR);
    var deltaZ = max(max(t.r, t.g), t.b);

    let cB = textureSampleLevel(colorTex, colorSampler, offset[1].zw, 0.0).rgb;
    t = abs(c - cB);
    var deltaW = max(max(t.r, t.g), t.b);

    // Calculate the maximum delta in the direct neighborhood:
    var maxDelta = max(vec2<f32>(deltaX, deltaY), vec2<f32>(deltaZ, deltaW));

    // Calculate left-left and top-top deltas:
    let cLL = textureSampleLevel(colorTex, colorSampler, offset[2].xy, 0.0).rgb;
    t = abs(c - cLL);
    deltaZ = max(max(t.r, t.g), t.b);

    let cTT = textureSampleLevel(colorTex, colorSampler, offset[2].zw, 0.0).rgb;
    t = abs(c - cTT);
    deltaW = max(max(t.r, t.g), t.b);

    // Calculate the final maximum delta:
    maxDelta = max(maxDelta.xy, vec2<f32>(deltaZ, deltaW));
    let finalDelta = max(maxDelta.x, maxDelta.y);

    // Local contrast adaptation (fixed factor 2.0 per SMAA spec):
    // Keep an edge only when its local delta is >= half the maximum neighbourhood delta.
    // This suppresses detector noise on low-contrast gradients while preserving real edges.
    edges = edges * step(vec2<f32>(finalDelta * 0.5), vec2<f32>(deltaX, deltaY));

    return edges;
}

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    // Calculate texel size
    let texelSize = 1.0 / camera.screenSize;
    
    // Calculate offsets in fragment shader
    var offset: array<vec4<f32>, 3>;
    
    // offset[0]: xy = left (-1,0), zw = top (0,-1)
    offset[0] = vec4<f32>(
        uv.x - texelSize.x, uv.y,
        uv.x, uv.y - texelSize.y
    );
    
    // offset[1]: xy = right (1,0), zw = bottom (0,1)
    offset[1] = vec4<f32>(
        uv.x + texelSize.x, uv.y,
        uv.x, uv.y + texelSize.y
    );
    
    // offset[2]: xy = far-left (-2,0), zw = far-top (0,-2)
    offset[2] = vec4<f32>(
        uv.x - 2.0 * texelSize.x, uv.y,
        uv.x, uv.y - 2.0 * texelSize.y
    );
    
    let edges = colorEdgeDetection(uv, offset);
    return vec4<f32>(edges.x, edges.y, 0.0, 1.0);
}