// Spawn de partículas en GPU: cada hilo saca un hueco de la free list y crea una partícula
// en la forma del emisor (módulo spawn). Ver ParticleSystemComponent.ts.
#include "common/particles"

struct SpawnParams {
    emitterMatrix: mat4x4<f32>, // offset   0: mundo ← emisor (identidad si las partículas viven en local)
    spawnCount: u32,            // offset  64
    seed: u32,                  // offset  68
    shape: u32,                 // offset  72: 0 box, 1 sphere, 2 hemisphere, 3 cone, 4 cylinder, 5 disc, 6 point
    trailLength: u32,           // offset  76: RIBBON: puntos de historial (0 = sin ribbon)
    shapeSize: vec3<f32>,       // offset  80: box: half-extents; cylinder: y = media altura; cone: y = largo
    radius: f32,                // offset  92: sphere / cylinder / disc / base del cono
    innerRadius: f32,           // offset  96: 0..1 — hueco interior (1 = solo la superficie / el borde)
    coneAngle: f32,             // offset 100: medio ángulo del cono (rad)
    radialSpeed: f32,           // offset 104: velocidad hacia fuera de la forma (normal)
    velocitySpread: f32,        // offset 108: dispersión aleatoria de la velocidad
    baseVelocity: vec3<f32>,    // offset 112: velocidad base (mundo)
    life: f32,                  // offset 124
    lifeVarMin: f32,            // offset 128
    lifeVarMax: f32,            // offset 132
    floorY: f32,                // offset 136: mueren al bajar de aquí (-1e9: sin suelo)
    sizeMul: f32,               // offset 140: escala del tamaño de esta ráfaga
    speedVariance: f32,         // offset 144: sale a (1 - speedVariance·rand) de su velocidad
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    // total: 160 bytes
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> spawnParams: SpawnParams;
@group(0) @binding(2) var<storage, read_write> freeList: array<u32>;
@group(0) @binding(3) var<storage, read_write> freeListCount: atomic<u32>;
@group(0) @binding(5) var<storage, read_write> trailHistory: array<vec4<f32>>;

const TAU: f32 = 6.2831853;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn rand(thread: u32, salt: u32) -> f32 {
    return f32(pcg(pcg(spawnParams.seed ^ (thread * 9781u)) + salt * 6271u)) / 4294967296.0;
}

fn randomUnit(thread: u32, salt: u32) -> vec3<f32> {
    let z = rand(thread, salt) * 2.0 - 1.0;
    let phi = rand(thread, salt + 1u) * TAU;
    let s = sqrt(max(1.0 - z * z, 0.0));
    return vec3<f32>(s * cos(phi), z, s * sin(phi));
}

/// Punto en un disco horizontal (XZ) de radio R, con un hueco interior (fracción del radio).
fn discPoint(thread: u32, salt: u32, R: f32) -> vec3<f32> {
    let inner = spawnParams.innerRadius;
    let r = R * sqrt(mix(inner * inner, 1.0, rand(thread, salt)));
    let phi = rand(thread, salt + 1u) * TAU;
    return vec3<f32>(r * cos(phi), 0.0, r * sin(phi));
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let thread = global_id.x;
    if (thread >= spawnParams.spawnCount) { return; }

    // Pop de la free list (O(1)). 0 → no quedaban huecos: se devuelve y no nace.
    let freeIndex = atomicSub(&freeListCount, 1u);
    if (freeIndex == 0u || freeIndex > arrayLength(&freeList)) {
        atomicAdd(&freeListCount, 1u);
        return;
    }
    let index = freeList[freeIndex - 1u];
    if (index >= arrayLength(&particles)) { return; }

    // ── Forma: posición y normal (dirección "hacia fuera") en el espacio del emisor ──
    var local = vec3<f32>(0.0);
    var normal = vec3<f32>(0.0, 1.0, 0.0);
    let shape = spawnParams.shape;
    if (shape == 0u) {
        // Caja (half-extents).
        local = (vec3<f32>(rand(thread, 10u), rand(thread, 11u), rand(thread, 12u)) * 2.0 - 1.0)
              * spawnParams.shapeSize;
        if (dot(local, local) > 1e-8) { normal = normalize(local); }
    } else if (shape == 1u || shape == 2u) {
        // Esfera / hemisferio (volumen con hueco interior; innerRadius 1 = cáscara).
        var dir = randomUnit(thread, 10u);
        if (shape == 2u) { dir.y = abs(dir.y); }
        let inner = spawnParams.innerRadius;
        let r = spawnParams.radius * pow(mix(inner * inner * inner, 1.0, rand(thread, 12u)), 1.0 / 3.0);
        local = dir * r;
        normal = dir;
    } else if (shape == 3u) {
        // Cono hacia +Y: dirección dentro del medio ángulo, desde un disco de base, a lo largo.
        let cosT = mix(1.0, cos(spawnParams.coneAngle), rand(thread, 10u));
        let sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
        let phi = rand(thread, 11u) * TAU;
        let dir = vec3<f32>(sinT * cos(phi), cosT, sinT * sin(phi));
        local = discPoint(thread, 13u, spawnParams.radius) + dir * spawnParams.shapeSize.y * rand(thread, 15u);
        normal = dir;
    } else if (shape == 4u || shape == 5u) {
        // Cilindro (eje Y) / disco horizontal: normal radial.
        local = discPoint(thread, 10u, spawnParams.radius);
        let rxz = length(local.xz);
        normal = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(local.x, 0.0, local.z) / max(rxz, 1e-5), rxz > 1e-5);
        if (shape == 4u) { local.y = (rand(thread, 12u) * 2.0 - 1.0) * spawnParams.shapeSize.y; }
    } else {
        // Punto: nace en el centro, sale en cualquier dirección.
        normal = randomUnit(thread, 10u);
    }

    let M = spawnParams.emitterMatrix;
    let position = (M * vec4<f32>(local, 1.0)).xyz;
    let n = (M * vec4<f32>(normal, 0.0)).xyz;
    let nWorld = select(vec3<f32>(0.0, 1.0, 0.0), normalize(n), dot(n, n) > 1e-10);

    // ── Velocidad: base + dispersión + hacia fuera de la forma ──
    let spread = (vec3<f32>(rand(thread, 20u), rand(thread, 21u), rand(thread, 22u)) * 2.0 - 1.0)
               * spawnParams.velocitySpread;
    let velocity = (spawnParams.baseVelocity + spread + nWorld * spawnParams.radialSpeed)
                 * (1.0 - spawnParams.speedVariance * rand(thread, 23u));

    let lifeVariance = mix(spawnParams.lifeVarMin, spawnParams.lifeVarMax, rand(thread, 30u));

    var p: Particle;
    p.position = position;
    p.floorY = spawnParams.floorY;
    p.velocity = velocity;
    p.lifetime = max(0.05, spawnParams.life + lifeVariance);
    p.age = 0.0;
    p.alive = 1u;
    p.sizeMul = spawnParams.sizeMul;
    p.trailHead = 0u;
    particles[index] = p;

    // RIBBON: el historial nace plegado en el punto de spawn (estela de largo 0).
    let N = spawnParams.trailLength;
    for (var k = 0u; k < N; k++) {
        trailHistory[index * N + k] = vec4<f32>(position, 0.0);
    }
}
