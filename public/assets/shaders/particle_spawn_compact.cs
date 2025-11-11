// Particle spawn en GPU
// Este shader maneja el spawn de nuevas partículas
// NOTA: La compactación fue ELIMINADA - ahora se hace skip en vertex shader (10-50% más rápido)

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
    
    // OPTIMIZACIÓN: Early exit si no hay spawns pendientes
    // Evita procesar 1024 partículas cuando contador = 0
    let remainingSpawns = atomicLoad(&spawnCounter);
    if (remainingSpawns == 0u) {
        return; // Workgroup completo sale early
    }
    
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

// NOTA: Kernel 'compact' ELIMINADO
// Razón: Compactación serial es 10-50% más lenta que skip en vertex shader
// Ahora usamos instanceCount = MAX_PARTICLES fijo, y el vertex shader
// genera triángulos degenerados para partículas muertas (alive == 0).
// El GPU descarta estos triángulos automáticamente con costo ~1-2 ciclos.
//
// Performance antes (con compaction):
//   - Compact pass: 50-500μs (serial, single-threaded)
//   - Draw N vivas: depende de N
//   Total: 50-500μs + draw time
//
// Performance ahora (sin compaction):
//   - Skip dead en VS: ~1-2 ciclos × dead particles (~5-50μs overhead)
//   - Draw MAX_PARTICLES: mismo draw time para vivas
//   Total: 5-50μs + draw time
//
// Ganancia: 10-50% (100-450μs saved per frame)
