struct Particle {
    position: vec3<f32>,
    velocity: vec3<f32>,
    lifetime: f32,
    age: f32,
    active: f32,
}

struct IndirectParams {
    vertexCount: u32,
    instanceCount: u32,
    firstVertex: u32,
    firstInstance: u32,
    padding: u32,
}

struct SimulationParams {
    deltaTime: f32,
    spawnCount: u32,
    emitterPosition: vec3<f32>,
    pad: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> indirectParams: IndirectParams;
@group(0) @binding(2) var<uniform> simulationParams: SimulationParams;

// Random number generation
fn hash(p: u32) -> f32 {
    var n = p;
    n = (n << 13u) ^ n;
    n = n * (n * n * 15731u + 789221u) + 1376312589u;
    return f32(n & 0x7fffffffu) / f32(0x7fffffff);
}

fn randomVec3(seed: u32) -> vec3<f32> {
    return vec3<f32>(
        hash(seed),
        hash(seed + 1u),
        hash(seed + 2u)
    ) * 2.0 - 1.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) GlobalInvocationID: vec3<u32>) {
    let index = GlobalInvocationID.x;
    if (index >= arrayLength(&particles)) {
        return;
    }

    var particle = particles[index];
    let dt = simulationParams.deltaTime;

    // Update existing particles
    if (particle.active > 0.0) {
        // Update position
        particle.position += particle.velocity * dt;
        
        // Apply gravity
        particle.velocity.y -= 9.8 * dt;
        
        // Update age
        particle.age += dt;
        
        // Check if particle should die
        if (particle.age >= particle.lifetime) {
            particle.active = 0.0;
            
            // Decrease instance count
            let oldCount = atomicSub(&indirectParams.instanceCount, 1u);
        }
    } 
    // Spawn new particles
    else if (simulationParams.spawnCount > 0u) {
        let shouldSpawn = atomicSub(&simulationParams.spawnCount, 1u);
        if (shouldSpawn > 0u) {
            // Reset particle
            particle.position = simulationParams.emitterPosition;
            
            // Random velocity
            let randDir = normalize(randomVec3(index + GlobalInvocationID.y));
            particle.velocity = randDir * (2.0 + hash(index + 3u) * 2.0); // Speed between 2-4
            
            // Set lifetime
            particle.lifetime = 2.0 + hash(index + 4u) * 1.0; // 2-3 seconds
            particle.age = 0.0;
            particle.active = 1.0;
            
            // Increase instance count
            let newCount = atomicAdd(&indirectParams.instanceCount, 1u);
        }
    }

    // Write back particle data
    particles[index] = particle;
}
