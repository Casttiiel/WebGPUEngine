// Particle spawn y compactación en GPU
// Este shader maneja el spawn de nuevas partículas y la compactación de vivas

struct Particle {
    position: vec3<f32>,
    padding1: f32,
    velocity: vec3<f32>,
    lifetime: f32,
    age: f32,
    alive: u32,
    padding2: u32,
    padding3: u32,
};

struct IndirectDrawArgs {
    indexCount: u32,
    instanceCount: u32,
    firstIndex: u32,
    baseVertex: i32,
    firstInstance: u32,
};

struct SpawnParams {
    spawnCount: u32,        // Cuántas partículas spawnear este frame
    randomSeed: f32,        // Seed para generación de números aleatorios
    padding1: f32,
    padding2: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> indirectArgs: IndirectDrawArgs;
@group(0) @binding(2) var<uniform> spawnParams: SpawnParams;
@group(0) @binding(3) var<storage, read_write> spawnCounter: atomic<u32>; // Contador atómico para spawn

// Función hash para números pseudo-aleatorios
fn hash(value: u32) -> u32 {
    var x = value;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

fn randomFloat(seed: u32) -> f32 {
    return f32(hash(seed)) / 4294967295.0;
}

// Kernel para spawn de partículas
@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    let totalParticles = arrayLength(&particles);
    
    if (index >= totalParticles) {
        return;
    }
    
    // Solo spawneamos si esta partícula está muerta
    if (particles[index].alive == 0u) {
        // Decrementar contador atómicamente PRIMERO
        let oldCount = atomicSub(&spawnCounter, 1u);
        
        // CRÍTICO: Verificar que oldCount era >= 1 ANTES del decremento
        // Si oldCount era 0, el resultado de atomicSub es 4294967295 (underflow)
        // Por lo tanto, necesitamos verificar que oldCount <= spawnCount original
        // para evitar false positives por underflow
        if (oldCount > 0u && oldCount <= 1024u) {  // 1024 = MAX_PARTICLES, límite razonable
            // Generamos números aleatorios basados en el índice y seed
            let seedBase = u32(spawnParams.randomSeed * 1000.0) + index;
            
            let randomX = (randomFloat(seedBase) - 0.5) * 2.0;
            let randomZ = (randomFloat(seedBase + 1000u) - 0.5) * 2.0;
            let randomLifetime = 3.0 + randomFloat(seedBase + 2000u) * 2.0; // 3-5 segundos
            
            // Inicializar nueva partícula
            particles[index].position = vec3<f32>(randomX, 5.0, randomZ);
            particles[index].velocity = vec3<f32>(0.0, -2.0, 0.0);
            particles[index].lifetime = randomLifetime;
            particles[index].age = 0.0;
            particles[index].alive = 1u;
        } else {
            // No había spawns disponibles o underflow detectado, restaurar el contador
            atomicAdd(&spawnCounter, 1u);
        }
    }
}

// Kernel para compactar partículas vivas al inicio del array
@compute @workgroup_size(1)
fn compact(@builtin(global_invocation_id) global_id: vec3<u32>) {
    if (global_id.x != 0u) {
        return;
    }
    
    let totalParticles = arrayLength(&particles);
    var writeIndex: u32 = 0u;
    
    // Primera pasada: compactar partículas vivas
    for (var readIndex = 0u; readIndex < totalParticles; readIndex++) {
        if (particles[readIndex].alive == 1u) {
            if (readIndex != writeIndex) {
                // Mover partícula viva a la posición compactada
                particles[writeIndex] = particles[readIndex];
                
                // Marcar el slot original como muerto (para evitar duplicados)
                particles[readIndex].alive = 0u;
            }
            writeIndex++;
        }
    }
    
    // Actualizar instanceCount para indirect draw
    indirectArgs.instanceCount = writeIndex;
}
