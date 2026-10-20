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
    // Scene sun (offset 116 = byte 464): xyz = direction toward the sun, w = 1 if present.
    sunDirection: vec4<f32>,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}


struct VsIn {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) worldPos:   vec3<f32>,
    // Camera position baked into object space so the FS can skip ObjectUniforms
    // (ObjectUniforms layout is vertex-only; FS access would fail pipeline creation).
    @location(1) roOS:       vec3<f32>,  // camera world pos → object space
    @location(2) col0:       vec3<f32>,  // modelMatrix column 0 (X axis * scaleX)
    @location(3) col1:       vec3<f32>,  // modelMatrix column 1
    @location(4) col2:       vec3<f32>,  // modelMatrix column 2
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

fn worldToObjectSpace(pWS: vec3<f32>, m: mat4x4<f32>) -> vec3<f32> {
    let sx2 = dot(m[0].xyz, m[0].xyz);
    let sy2 = dot(m[1].xyz, m[1].xyz);
    let sz2 = dot(m[2].xyz, m[2].xyz);
    let d   = pWS - m[3].xyz;
    return vec3<f32>(
        dot(d, m[0].xyz) / sx2,
        dot(d, m[1].xyz) / sy2,
        dot(d, m[2].xyz) / sz2,
    );
}

@vertex
fn vs(in: VsIn) -> VsOut {
    let m        = object.modelMatrix;
    let worldPos = (m * vec4<f32>(in.position, 1.0)).xyz;
    var out: VsOut;
    out.worldPos = worldPos;
    out.clip     = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    out.roOS     = worldToObjectSpace(camera.cameraPosition.xyz, m);
    out.col0     = m[0].xyz;
    out.col1     = m[1].xyz;
    out.col2     = m[2].xyz;
    return out;
}
