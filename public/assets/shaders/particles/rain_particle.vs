#include "common/uniforms"

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
