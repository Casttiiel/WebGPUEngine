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


struct Particle {
    position: vec3<f32>,
    padding1: f32,
    velocity: vec3<f32>,
    lifetime: f32,
    age:      f32,
    alive:    u32,
    padding2: u32,
    padding3: u32,
};

struct ParticleRenderParams {
    startSize:  f32,
    endSize:    f32,
    padding1:   f32,
    padding2:   f32,
    startColor: vec4<f32>,
    endColor:   vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera:       CameraUniforms;
@group(2) @binding(0) var<uniform> object:       ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;
@group(3) @binding(1) var<uniform> renderParams: ParticleRenderParams;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position:      vec4<f32>,
    @location(0)       uv:            vec2<f32>,
    @location(1)       particleColor: vec4<f32>,
};

// How many times longer than wide each streak is.
const STRETCH: f32 = 12.0;

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    let particle = particles[input.instanceIndex];

    if (particle.alive == 0u) {
        var out: VertexOutput;
        out.position      = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        out.uv            = vec2<f32>(0.0);
        out.particleColor = vec4<f32>(0.0);
        return out;
    }

    let t     = clamp(particle.age / max(particle.lifetime, 0.0001), 0.0, 1.0);
    let size  = mix(renderParams.startSize, renderParams.endSize, t);
    let color = mix(renderParams.startColor, renderParams.endColor, t);

    // Velocity-aligned billboard:
    //   velDir  = normalised velocity (down by default when particle is still)
    //   right   = perpendicular to velDir in the plane facing the camera
    //   offset  = right × width  +  velDir × (height × STRETCH)
    let vel   = particle.velocity;
    let speed = length(vel);
    let velDir = select(vec3<f32>(0.0, -1.0, 0.0), vel / speed, speed > 0.001);

    let toCamera  = normalize(camera.cameraPosition.xyz - particle.position);
    let crossVec  = cross(velDir, toCamera);
    let crossLen  = length(crossVec);
    let right     = select(vec3<f32>(1.0, 0.0, 0.0), crossVec / crossLen, crossLen > 0.001);

    // input.position.x ∈ [-0.5, 0.5] → width axis
    // input.position.y ∈ [-0.5, 0.5] → length axis (stretched along velocity)
    let offset   = right * input.position.x * size
                 + velDir * input.position.y * size * STRETCH;

    let worldPos = particle.position + offset;
    let clipPos  = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);

    var out: VertexOutput;
    out.position      = clipPos;
    out.uv            = input.uv;
    out.particleColor = color;
    return out;
}
