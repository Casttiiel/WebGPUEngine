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


struct DOFUniforms {
    focus_distance: f32,
    aperture: f32,
    focal_length: f32,
    sensor_height: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// DOF Parameters
@group(2) @binding(0) var<uniform> dofParams: DOFUniforms;

// Calcula Circle of Confusion usando ecuación física de lente
fn calculateCoC(worldDepth: f32) -> f32 {
    let subjectDistance = worldDepth;
    let focusDistance = dofParams.focus_distance;
    
    // Evitar división por cero
    if (abs(subjectDistance - focusDistance) < 0.01) {
        return 0.0; // In focus
    }
    
    // Ecuación física de la lente:
    // CoC = (A * F * |S - D|) / (S * (D - F))
    // A = aperture diameter = focal_length / f_stop
    // F = focal_length
    // S = subject_distance
    // D = focus_distance
    
    let apertureDiameter = dofParams.focal_length / dofParams.aperture;
    let numerator = apertureDiameter * dofParams.focal_length * abs(subjectDistance - focusDistance);
    let denominator = subjectDistance * max(focusDistance - dofParams.focal_length, 0.001);
    
    let cocMM = numerator / denominator; // CoC en milímetros
    
    // Convertir a píxeles (normalizado por altura del sensor)
    let resolution = vec2<f32>(textureDimensions(gLinearDepth));
    let cocPixels = (cocMM / dofParams.sensor_height) * resolution.y;
    
    // Signo indica near (-) o far (+)
    let sign = sign(subjectDistance - focusDistance);
    
    return clamp(cocPixels * sign, -50.0, 50.0); // Limitar a ±50px
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    
    // Detectar skybox (depth = 1.0) → CoC = 0 (siempre enfocado)
    if (linearDepth >= 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    
    let worldDepth = linearDepth * camera.cameraFar;
    let coc = calculateCoC(worldDepth);
    
    // Separar near/far para optimizaciones
    let nearCoC = max(-coc, 0.0); // Solo valores negativos (foreground)
    let farCoC = max(coc, 0.0);   // Solo valores positivos (background)
    
    // R: Far CoC, G: Near CoC, B: Full CoC (signed), A: unused
    return vec4<f32>(farCoC, nearCoC, coc, 1.0);
}
