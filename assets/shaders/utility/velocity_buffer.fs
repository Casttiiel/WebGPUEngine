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


/**
 * Velocity Buffer Fragment Shader
 * 
 * Genera motion vectors (velocidad en screen space) comparando:
 * - Posición actual del píxel (current frame)
 * - Posición reproyectada usando previous ViewProjection matrix
 * 
 * Output: vec2(velocityX, velocityY) en RG16Float texture
 */

// Previous frame ViewProjection matrix
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;
// @group(2) — Unjittered matrices for velocity generation.
// Using unjittered matrices on BOTH sides ensures that for a perfectly static scene with
// a static camera the velocity is exactly zero, even when camera jitter is active.
// Using the jittered VP (from CameraUniforms) for reconstruction causes the jitter-sign
// alternation (A→B→A→B each frame) to produce a non-zero oscillating velocity → vibration.
@group(2) @binding(0) var<uniform> previousUnjitteredVP:   mat4x4<f32>; // prev frame unjittered VP
@group(2) @binding(1) var<uniform> currentUnjitteredInvVP: mat4x4<f32>; // current frame unjittered inv VP

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
};

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Sample depth del frame actual
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, input.Uv).x;

    // Sky pixels have linearDepth = 0 (G-Buffer cleared to 0, no geometry written).
    // The normal reconstruction divides by viewZ = 0, producing NaN velocity → TSR ghosts.
    // Instead, compute velocity from a far-away point in the view direction so that
    // camera ROTATION is captured correctly (translation effect is negligible at 10 km).
    if (linearDepth < 0.0001) {
        let ndcX = input.Uv.x * 2.0 - 1.0;
        let ndcY = (1.0 - input.Uv.y) * 2.0 - 1.0;
        var farWorld = currentUnjitteredInvVP * vec4<f32>(ndcX, ndcY, 1.0, 1.0);
        farWorld /= farWorld.w;
        let skyDir   = normalize(farWorld.xyz - camera.cameraPosition.xyz);
        let skyPt    = vec4<f32>(camera.cameraPosition.xyz + skyDir * 10000.0, 1.0);
        let prevClip = previousUnjitteredVP * skyPt;
        let prevNDC  = prevClip.xy / prevClip.w;
        let prevUV   = vec2<f32>(prevNDC.x * 0.5 + 0.5, 1.0 - (prevNDC.y * 0.5 + 0.5));
        return vec4<f32>(input.Uv - prevUV, 0.0, 0.0);
    }

    // Early exit si hay geometría justo en el far plane (depth = 1.0)
    if (linearDepth >= 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // 2. Reconstruir posición world del frame actual usando unjittered inv VP.
    // IMPORTANTE: NO usar camera.invViewProjection aquí — ese tiene el jitter del frame actual
    // incorporado. El jitter alterna signo cada frame, por lo que worldPos oscilaría
    // ligeramente cada frame → velocity oscila → vibración de cámara.
    //
    // gLinearDepth almacena depth lineal = length(worldPos-camPos) / cameraFar [0..1].
    // La matriz invVP espera NDC Z (perspectiveZO de gl-matrix).
    //
    // Derivación universal (funciona para standard Z y reverse Z):
    //   clip.z = P10 * (-viewZ) + P14   (viewZ = distancia positiva a cámara)
    //   clip.w = viewZ
    //   ndcZ   = clip.z / clip.w = P14/viewZ - P10
    //
    // En standard Z P10 < 0, P14 < 0  → ndcZ ∈ [0,1] con 0=near, 1=far
    // En reverse Z  P10 > 0, P14 > 0  → ndcZ ∈ [0,1] con 1=near, 0=far
    // La fórmula anterior (far*(viewZ-near)/(viewZ*(far-near))) falla en reverse Z porque
    // P14/P10 devuelve la distancia al far plane en vez de near, haciendo (far-near) ≈ 0.
    let P10   = camera.projectionMatrix[2][2];
    let P14   = camera.projectionMatrix[3][2];
    let far   = camera.cameraFar;
    let viewZ = linearDepth * far;  // distancia world-space a la cámara
    let ndcZ  = P14 / viewZ - P10; // válido para standard Z y reverse Z

    let ndcX = input.Uv.x * 2.0 - 1.0;
    let ndcY = (1.0 - input.Uv.y) * 2.0 - 1.0; // Invertir Y (texture UV vs NDC)
    let ndcW = 1.0;
    
    let clipSpacePos = vec4<f32>(ndcX, ndcY, ndcZ, ndcW);
    
    var worldPos = currentUnjitteredInvVP * clipSpacePos;
    worldPos = worldPos / worldPos.w;
    
    // 3. Reproyectar world position usando previousUnjitteredVP.
    // Static camera + static scene → prevNDC == currentNDC → velocity = 0 ✓
    let previousClipSpace = previousUnjitteredVP * worldPos;
    var previousNDC = previousClipSpace.xyz / previousClipSpace.w;
    
    // 4. Convertir previous NDC a UV coordinates
    let previousUV = vec2<f32>(
        previousNDC.x * 0.5 + 0.5,
        1.0 - (previousNDC.y * 0.5 + 0.5) // Invertir Y de vuelta a UV space
    );
    
    // 5. Calcular velocity (diferencia entre current y previous UV)
    let velocity = input.Uv - previousUV;
    
    // 6. Escalar velocity a píxeles (opcional, para visualización/debug)
    // let resolution = vec2<f32>(1920.0, 1080.0); // TODO: pasar como uniform
    // let velocityPixels = velocity * resolution;
    
    // Output: velocity en RG, BA sin usar (0.0, 0.0)
    // Positivo = objeto se mueve hacia abajo/derecha
    // Negativo = objeto se mueve hacia arriba/izquierda
    return vec4<f32>(velocity.x, velocity.y, 0.0, 0.0);
}
