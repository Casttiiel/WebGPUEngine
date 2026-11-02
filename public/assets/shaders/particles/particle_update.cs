// Update de partículas en GPU: edad, fuerzas, muerte (→ free list) y módulos opcionales por
// #define (ParticleSystemComponent compila solo los que usa el emisor):
//   CURL_NOISE, VORTEX, ATTRACTOR — fuerzas
//   RIBBON — guarda el historial de posiciones (estela de cada partícula)
//   LIGHTS — las partículas escogidas escriben point lights en la cola del buffer del tiled
#include "common/particles"

struct SimParams {
    emitterMatrix: mat4x4<f32>, // offset   0: mundo ← espacio de las partículas (luces)
    gravity: vec3<f32>,         // offset  64: aceleración (m/s²)
    deltaTime: f32,             // offset  76
    drag: f32,                  // offset  80: v *= exp(-drag·dt)
    time: f32,                  // offset  84
    recordTrail: u32,           // offset  88: RIBBON: 1 = este frame se guarda un punto
    trailLength: u32,           // offset  92: RIBBON: puntos por partícula
    curl: vec4<f32>,            // offset  96: x = fuerza, y = frecuencia (1/m), z = velocidad del flujo
    vortexCenter: vec3<f32>,    // offset 112: en el espacio de las partículas
    vortexStrength: f32,        // offset 124: giro alrededor del eje (rad/s)
    vortexAxis: vec3<f32>,      // offset 128: unitario
    vortexPull: f32,            // offset 140: aceleración hacia el eje
    attractorPos: vec3<f32>,    // offset 144: en el espacio de las partículas
    attractorStrength: f32,     // offset 156
    attractorRadius: f32,       // offset 160: alcance (0 = infinito)
    lightFraction: f32,         // offset 164: fracción de partículas con luz (las más grandes)
    lightMax: u32,              // offset 168: tope de luces de este emisor
    lightRadius: f32,           // offset 172
    lightColor: vec3<f32>,      // offset 176
    lightIntensity: f32,        // offset 188
    lightUseParticleColor: f32, // offset 192: 1 = color de la partícula (curva) × lightColor
    lightBase: u32,             // offset 196: primer hueco de luces de partículas en el buffer del tiled
    lightSlots: u32,            // offset 200: huecos reservados
    lightFalloffStart: f32,     // offset 204: fracción del radio a plena intensidad
    // total: 208 bytes
};

struct PointLightEntry {
    colorIntensity: vec4<f32>,
    posRadius: vec4<f32>,
    falloff: vec4<f32>,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> sim: SimParams;
@group(0) @binding(2) var<storage, read_write> freeList: array<u32>;
@group(0) @binding(3) var<storage, read_write> freeListCount: atomic<u32>;
#ifdef LIGHTS
@group(0) @binding(4) var<uniform> curves: ParticleCurves;
#endif
#ifdef RIBBON
@group(0) @binding(5) var<storage, read_write> trailHistory: array<vec4<f32>>;
#endif
#ifdef LIGHTS
@group(0) @binding(6) var<storage, read_write> pointLights: array<PointLightEntry>;
@group(0) @binding(7) var<storage, read_write> particleLightCount: atomic<u32>;
@group(0) @binding(8) var<storage, read_write> emitterLightCount: atomic<u32>;
#endif

#ifdef CURL_NOISE
fn hash3i(p: vec3<i32>) -> f32 {
    var v = vec3<u32>(p) * vec3<u32>(1664525u) + vec3<u32>(1013904223u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> vec3<u32>(16u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return f32(v.x) / 2147483648.0 - 1.0; // [-1, 1)
}

// Value noise 3D con su gradiente analítico: (valor, d/dx, d/dy, d/dz).
fn noised(x: vec3<f32>) -> vec4<f32> {
    let pf = floor(x);
    let i = vec3<i32>(pf);
    let f = x - pf;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let a = hash3i(i + vec3<i32>(0, 0, 0));
    let b = hash3i(i + vec3<i32>(1, 0, 0));
    let c = hash3i(i + vec3<i32>(0, 1, 0));
    let d = hash3i(i + vec3<i32>(1, 1, 0));
    let e = hash3i(i + vec3<i32>(0, 0, 1));
    let g = hash3i(i + vec3<i32>(1, 0, 1));
    let h = hash3i(i + vec3<i32>(0, 1, 1));
    let k = hash3i(i + vec3<i32>(1, 1, 1));
    let k1 = b - a;
    let k2 = c - a;
    let k3 = e - a;
    let k4 = a - b - c + d;
    let k5 = a - c - e + h;
    let k6 = a - b - e + g;
    let k7 = -a + b + c - d + e - g - h + k;
    let value = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z
              + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
    let grad = du * vec3<f32>(
        k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y,
    );
    return vec4<f32>(value, grad);
}

// Rotacional de un potencial de 3 ruidos: un flujo sin divergencia (remolinos, sin sumideros).
fn curlNoise(p: vec3<f32>) -> vec3<f32> {
    let n1 = noised(p).yzw;
    let n2 = noised(p + vec3<f32>(31.416, -47.853, 12.793)).yzw;
    let n3 = noised(p + vec3<f32>(-233.1, 104.7, 71.3)).yzw;
    return vec3<f32>(n3.y - n2.z, n1.z - n3.x, n2.x - n1.y);
}
#endif

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= arrayLength(&particles)) { return; }

    var particle = particles[index];
    if (particle.alive == 0u) { return; }

    let dt = sim.deltaTime;
    particle.age += dt;

    // ── Fuerzas ──
    var accel = sim.gravity;
#ifdef CURL_NOISE
    let flow = vec3<f32>(0.37, 1.0, -0.21) * sim.time * sim.curl.z;
    accel += curlNoise(particle.position * sim.curl.y + flow) * sim.curl.x;
#endif
#ifdef VORTEX
    // Vortex velocity (como en Niagara): gira la posición alrededor del eje a `vortexStrength`
    // rad/s sin acumularlo en la velocidad (una aceleración tangencial acaba lanzándolas
    // fuera); `vortexPull` sí es una aceleración hacia el eje.
    {
        let r = particle.position - sim.vortexCenter;
        let along = sim.vortexAxis * dot(r, sim.vortexAxis);
        let rPerp = r - along;
        let d = length(rPerp);
        if (d > 1e-4) {
            let angle = sim.vortexStrength * dt;
            let rotated = rPerp * cos(angle) + cross(sim.vortexAxis, rPerp) * sin(angle);
            particle.position = sim.vortexCenter + along + rotated;
            accel -= rPerp / d * sim.vortexPull;
        }
    }
#endif
#ifdef ATTRACTOR
    {
        let toAttractor = sim.attractorPos - particle.position;
        let d = length(toAttractor);
        if (d > 1e-4) {
            let falloff = select(1.0, saturate(1.0 - d / sim.attractorRadius), sim.attractorRadius > 0.0);
            accel += toAttractor / d * sim.attractorStrength * falloff;
        }
    }
#endif

    particle.velocity += accel * dt;
    particle.velocity *= exp(-sim.drag * dt);
    particle.position += particle.velocity * dt;

    // ── Muerte: por edad o al tocar su suelo → push a la free list ──
    if (particle.age >= particle.lifetime || particle.position.y < particle.floorY) {
        particle.alive = 0u;
        let freeSlot = atomicAdd(&freeListCount, 1u);
        if (freeSlot < arrayLength(&freeList)) {
            freeList[freeSlot] = index;
        }
        particles[index] = particle;
        return;
    }

#ifdef RIBBON
    if (sim.recordTrail == 1u) {
        let N = sim.trailLength;
        trailHistory[index * N + particle.trailHead] = vec4<f32>(particle.position, 0.0);
        particle.trailHead = (particle.trailHead + 1u) % N;
    }
#endif

#ifdef LIGHTS
    // Las más grandes (mismo azar que el tamaño en el VS) llevan luz, hasta el tope del emisor.
    if (particleRand(index, particle.lifetime, 5u) >= 1.0 - sim.lightFraction) {
        if (atomicAdd(&emitterLightCount, 1u) < sim.lightMax) {
            let slot = atomicAdd(&particleLightCount, 1u);
            if (slot < sim.lightSlots) {
                let c = curveColor(curves, particle.age / max(particle.lifetime, 1e-4));
                let color = sim.lightColor * mix(vec3<f32>(1.0), c.rgb, sim.lightUseParticleColor);
                let worldPos = (sim.emitterMatrix * vec4<f32>(particle.position, 1.0)).xyz;
                pointLights[sim.lightBase + slot] = PointLightEntry(
                    vec4<f32>(color, sim.lightIntensity * c.a),
                    vec4<f32>(worldPos, sim.lightRadius),
                    vec4<f32>(sim.lightRadius * sim.lightFalloffStart, 0.0, 0.0, 0.0),
                );
            }
        }
    }
#endif

    particles[index] = particle;
}
