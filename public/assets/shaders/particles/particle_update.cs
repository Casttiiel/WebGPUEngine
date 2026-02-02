// Estructura de la partícula (debe coincidir con particle.vs)
struct Particle {
    position: vec3<f32>,
    padding1: f32,
    velocity: vec3<f32>,
    lifetime: f32,    // Tiempo total de vida
    age: f32,         // Edad actual
    alive: u32,      // 1 = viva, 0 = muerta
    padding2: u32,    // Alineamiento
    padding3: u32,    // Alineamiento (total: 48 bytes)
};

// Buffer de argumentos para drawIndexedIndirect
struct IndirectDrawArgs {
    indexCount: u32,      // Número de índices (6 para un quad)
    instanceCount: u32,   // Número de instancias (partículas vivas)
    firstIndex: u32,      // Primer índice
    baseVertex: i32,      // Vértice base
    firstInstance: u32,   // Primera instancia
};

// Parámetros de simulación (32 bytes total)
struct SimulationParams {
    deltaTime: f32,
    padding1: f32,
    padding2: f32,
    padding3: f32,
    padding4: f32,
    padding5: f32,
    padding6: f32,
    padding7: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> indirectArgs: IndirectDrawArgs;
@group(0) @binding(2) var<uniform> simParams: SimulationParams;
@group(0) @binding(3) var<storage, read_write> spawnCounter: atomic<u32>; // Dummy para layout compartido
@group(0) @binding(4) var<storage, read_write> freeList: array<u32>; // Stack de índices libres
@group(0) @binding(5) var<storage, read_write> freeListCount: atomic<u32>; // Contador de slots libres

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    
    // Verificar que el índice está dentro del rango
    if (index >= arrayLength(&particles)) {
        return;
    }
    
    // Obtener la partícula actual
    var particle = particles[index];
    
    // Solo actualizar partículas vivas
    if (particle.alive == 1u) {
        // Incrementar edad
        particle.age += simParams.deltaTime;
        
        // Actualizar posición basándose en velocidad y deltaTime
        particle.position += particle.velocity * simParams.deltaTime;
        
        // Comprobar si ha superado su tiempo de vida
        if (particle.age >= particle.lifetime) {
            particle.alive = 0u; // Marcar como muerta
            
            // OPTIMIZACIÓN: Push a free list cuando muere
            // Esto permite que spawn haga O(1) lookups en vez de O(n) scan.
            // Incrementar contador atómicamente para obtener slot en free list
            let freeSlot = atomicAdd(&freeListCount, 1u);
            
            // Validar que no excedemos el tamaño del array
            if (freeSlot < arrayLength(&freeList)) {
                // Push del índice de esta partícula a la free list (stack push)
                freeList[freeSlot] = index;
            }
        }
    }
    
    // Escribir la partícula actualizada de vuelta al buffer
    particles[index] = particle;
}
