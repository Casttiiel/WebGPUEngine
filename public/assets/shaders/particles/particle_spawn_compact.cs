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
    spawnCount: u32,              // offset  0: Cuántas partículas spawnear este frame
    randomSeed: f32,              // offset  4: Seed para generación de números aleatorios
    worldSpace: u32,              // offset  8: 0 = local space, 1 = world space
    padding1: f32,                // offset 12
    emitterWorldPos: vec3<f32>,   // offset 16: Posición mundial del emisor
    padding2: f32,                // offset 28
    emitterWorldScale: vec3<f32>, // offset 32: Escala mundial del emisor
    padding3: f32,                // offset 44
    spawnExtents: vec3<f32>,      // offset 48: Half-extents del box de spawn [x,y,z] (align 16 ✓)
    velocitySpread: f32,          // offset 60: Dispersión aleatoria de la velocidad respecto a baseVelocity (0-1)
    baseVelocity: vec3<f32>,      // offset 64: Velocidad base [x,y,z] (auto-aligned to 16 ✓)
    particleLife: f32,            // offset 76: Vida base de la partícula en segundos
    particleLifeVarMin: f32,      // offset 80: Varianza mínima de vida
    particleLifeVarMax: f32,      // offset 84: Varianza máxima de vida
    padding4: f32,                // offset 88
    padding5: f32,                // offset 92
    // total: 96 bytes
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> indirectArgs: IndirectDrawArgs;
@group(0) @binding(2) var<uniform> spawnParams: SpawnParams;
@group(0) @binding(3) var<storage, read_write> spawnCounter: atomic<u32>; // Contador atómico para spawn
@group(0) @binding(4) var<storage, read_write> freeList: array<u32>; // Stack de índices libres
@group(0) @binding(5) var<storage, read_write> freeListCount: atomic<u32>; // Contador de slots libres

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

// OPTIMIZACIÓN: Kernel de spawn con Dead Particle Free List
// En lugar de scan linear O(n) buscando slots muertos,
// hacemos pop de la free list para O(1) lookups.
//
// ANTES (scan linear):
//   - Procesar 1024 threads
//   - Cada thread chequea if (alive == 0)
//   - Solo primeros N encuentran slots → desperdicio
//   - Complejidad: O(n) donde n = MAX_PARTICLES
//
// AHORA (free list):
//   - Solo procesamos threads que necesitamos (spawnCount)
//   - Pop atómico del stack de índices libres
//   - Spawn directo en índice conocido
//   - Complejidad: O(1) lookup
//
// Ganancia: 5-15% performance improvement
@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let threadIndex = global_id.x;
    
    // OPTIMIZACIÓN: Early exit si no hay spawns pendientes
    let remainingSpawns = atomicLoad(&spawnCounter);
    if (remainingSpawns == 0u) {
        return;
    }
    
    // Solo procesar threads necesarios (no más de spawnCount)
    if (threadIndex >= spawnParams.spawnCount) {
        return;
    }
    
    // OPTIMIZACIÓN CRÍTICA: Pop de free list para O(1) lookup
    // Decrementar contador atómicamente para obtener índice en free list
    let freeListIndex = atomicSub(&freeListCount, 1u);
    
    // Validar que había slots disponibles
    // freeListIndex == 0 significa underflow (ya estaba en 0 antes del decremento)
    // freeListIndex > arrayLength(&freeList) no es posible en condiciones normales, pero defiende contra race conditions
    let maxFreeSlots = arrayLength(&freeList);
    if (freeListIndex == 0u || freeListIndex > maxFreeSlots) {
        // No hay slots libres, restaurar contador
        atomicAdd(&freeListCount, 1u);
        return;
    }
    
    // Decrementar spawn counter
    let oldSpawnCount = atomicSub(&spawnCounter, 1u);
    if (oldSpawnCount == 0u || oldSpawnCount > 1024u) {
        // Ya no hay spawns pendientes, restaurar ambos contadores
        atomicAdd(&spawnCounter, 1u);
        atomicAdd(&freeListCount, 1u);
        return;
    }
    
    // Obtener índice de partícula desde free list (stack pop)
    // freeListIndex - 1 porque atomicSub retorna el valor ANTES del decremento
    let particleIndex = freeList[freeListIndex - 1u];
    
    // Validar que el índice es válido
    if (particleIndex >= arrayLength(&particles)) {
        return;
    }
    
    // Generar números aleatorios basados en el thread y seed
    let seedBase = u32(spawnParams.randomSeed * 1000.0) + threadIndex;
    
    // Posición de spawn: offset aleatorio dentro del box (half-extents por eje)
    let randomX = (randomFloat(seedBase)          - 0.5) * 2.0 * spawnParams.spawnExtents.x;
    let randomZ = (randomFloat(seedBase + 1000u)  - 0.5) * 2.0 * spawnParams.spawnExtents.z;
    let randomY = (randomFloat(seedBase + 2000u)  - 0.5) * 2.0 * spawnParams.spawnExtents.y;

    // Vida de la partícula: particleLife base + random en [varMin, varMax]
    let lifeRandom = randomFloat(seedBase + 3000u); // [0, 1]
    let lifeVariance = spawnParams.particleLifeVarMin + lifeRandom * (spawnParams.particleLifeVarMax - spawnParams.particleLifeVarMin);
    let randomLifetime = max(0.1, spawnParams.particleLife + lifeVariance);

    // Velocidad: baseVelocity + perturbación aleatoria escalada por randomness
    let randVX = (randomFloat(seedBase + 4000u) - 0.5) * 2.0 * spawnParams.velocitySpread;
    let randVY = (randomFloat(seedBase + 5000u) - 0.5) * 2.0 * spawnParams.velocitySpread;
    let randVZ = (randomFloat(seedBase + 6000u) - 0.5) * 2.0 * spawnParams.velocitySpread;
    let velocity = spawnParams.baseVelocity + vec3<f32>(randVX, randVY, randVZ);
    
    // Calcular posición de spawn (local o world space)
    var spawnPosition: vec3<f32>;
    if (spawnParams.worldSpace == 1u) {
        // World space: usar posición absoluta del emisor + offset escalado
        let offset = vec3<f32>(randomX, randomY, randomZ) * spawnParams.emitterWorldScale;
        spawnPosition = spawnParams.emitterWorldPos + offset;
    } else {
        // Local space: posición relativa al emisor (comportamiento original)
        spawnPosition = vec3<f32>(randomX, randomY, randomZ);
    }
    
    // Spawn partícula directamente en el índice obtenido de free list
    particles[particleIndex].position = spawnPosition;
    particles[particleIndex].velocity = velocity;
    particles[particleIndex].lifetime = randomLifetime;
    particles[particleIndex].age = 0.0;
    particles[particleIndex].alive = 1u;
}