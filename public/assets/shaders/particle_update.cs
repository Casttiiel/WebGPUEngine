// Estructura de la partícula (debe coincidir con particle.vs)
struct Particle {
    position: vec3<f32>,
    padding1: f32,
    velocity: vec3<f32>,
    padding2: f32,
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
@group(0) @binding(1) var<uniform> simParams: SimulationParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    
    // Verificar que el índice está dentro del rango
    if (index >= arrayLength(&particles)) {
        return;
    }
    
    // Obtener la partícula actual
    var particle = particles[index];
    
    // Actualizar posición basándose en velocidad y deltaTime
    particle.position += particle.velocity * simParams.deltaTime;
    
    // Opcional: Aplicar gravedad
    /*particle.velocity.y -= 9.8 * simParams.deltaTime;
    
    // Opcional: Rebote simple en el suelo
    if (particle.position.y < 0.0) {
        particle.position.y = 0.0;
        particle.velocity.y = abs(particle.velocity.y) * 0.8; // Rebote con amortiguación
    }*/
    
    // Escribir la partícula actualizada de vuelta al buffer
    particles[index] = particle;
}
