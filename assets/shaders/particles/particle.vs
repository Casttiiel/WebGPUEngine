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


// Estructura de la partícula (alineada para storage buffer)
struct Particle {
    position: vec3<f32>,
    padding1: f32,    // Alineamiento
    velocity: vec3<f32>,
    lifetime: f32,    // Tiempo total de vida
    age: f32,         // Edad actual
    alive: u32,      // 1 = viva, 0 = muerta
    padding2: u32,    // Alineamiento
    padding3: u32,    // Alineamiento (total: 48 bytes)
};

// Parámetros de renderizado compartidos entre VS y FS
struct ParticleRenderParams {
    startSize:  f32,           // offset  0
    endSize:    f32,           // offset  4
    padding1:   f32,           // offset  8
    padding2:   f32,           // offset 12
    startColor: vec4<f32>,     // offset 16
    endColor:   vec4<f32>,     // offset 32
    // total: 48 bytes
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;
@group(3) @binding(1) var<uniform>  renderParams: ParticleRenderParams;

// Vertex attributes del quad mesh
struct VertexInput {
    @location(0) position: vec3<f32>, // posición del vértice del quad
    @location(1) normal: vec3<f32>,   // normal del quad (no se usa pero está en el mesh)
    @location(2) uv: vec2<f32>,       // UV del quad
    @location(3) tangent: vec4<f32>,  // tangent del quad (no se usa pero está en el mesh)
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>, // Color interpolado (startColor → endColor)
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    // Obtener la partícula actual usando el instance index
    let particle = particles[input.instanceIndex];

    // OPTIMIZACIÓN CRÍTICA: Skip dead particles generando triángulo degenerado
    if (particle.alive == 0u) {
        var output: VertexOutput;
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Degenerate triangle (w=0)
        output.uv = vec2<f32>(0.0, 0.0);
        output.particleColor = vec4<f32>(0.0);
        return output;
    }

    // t: fracción de vida [0 = recién nacida, 1 = a punto de morir]
    let t = clamp(particle.age / max(particle.lifetime, 0.0001), 0.0, 1.0);

    // Tamaño interpolado
    let size = mix(renderParams.startSize, renderParams.endSize, t);

    // Color interpolado
    let color = mix(renderParams.startColor, renderParams.endColor, t);

    // Billboarding: extraer vectores right y up de las matrices de cámara
    let cameraRight = normalize(vec3<f32>(camera.viewMatrix[0].x, camera.viewMatrix[1].x, camera.viewMatrix[2].x));
    let cameraUp    = normalize(vec3<f32>(camera.viewMatrix[0].y, camera.viewMatrix[1].y, camera.viewMatrix[2].y));

    // Calcular offset del vértice del quad con el tamaño interpolado
    let quadOffset = (cameraRight * input.position.x + cameraUp * input.position.y) * size;

    // LOCAL SPACE MODE: La partícula está en espacio local del emisor
    // Aplicamos modelMatrix al conjunto (offset + posición de la partícula)
    let localPos = quadOffset + particle.position;
    let worldPos = object.modelMatrix * vec4<f32>(localPos, 1.0);
    let clipPos  = camera.projectionMatrix * camera.viewMatrix * worldPos;

    var output: VertexOutput;
    output.position      = clipPos;
    output.uv            = input.uv;
    output.particleColor = color;
    
    return output;
}