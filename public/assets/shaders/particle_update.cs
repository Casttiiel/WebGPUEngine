struct ParticlesBuffer {
    data: array<f32>,
}

struct TimeUniforms {
    deltaTime: f32,
}

@group(0) @binding(0) var<storage, read_write> particleBuffer: ParticlesBuffer;
@group(0) @binding(1) var<uniform> time: TimeUniforms;

@compute @workgroup_size(4)
fn cs(@builtin(global_invocation_id) global_id : vec3u) {
    let index = global_id.x;
    if (index >= 4u) {
        return;
    }

    // Cada partícula tiene 3 floats [x,y,z]
    let base = index * 3u;

    // Mantén x y z, pero asegura que y sea 1.0
    particleBuffer.data[base] = particleBuffer.data[base];     // x se mantiene
    particleBuffer.data[base + 1u] = 1.0;                     // y siempre es 1.0
    particleBuffer.data[base + 2u] = particleBuffer.data[base + 2u];  // z se mantiene
}
