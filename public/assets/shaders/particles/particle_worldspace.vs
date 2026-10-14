#include "common/uniforms"

// Estructura de la partícula (alineada para storage buffer)
struct Particle {
    position: vec3<f32>,
    padding1: f32,    // Alineamiento
    velocity: vec3<f32>,
    lifetime: f32,    // Tiempo total de vida
    age: f32,         // Edad actual
    alive: u32,      // 1 = viva, 0 = muerta
    padding2: u32,    // Alineamiento
    padding3: u32,    // Alineamiento (total: 48 bytes)
};

// Parámetros de renderizado compartidos entre VS y FS
// (startSize, endSize, startColor, endColor − vienen del componente CPU)
struct ParticleRenderParams {
    startSize:   f32,          // offset  0
    endSize:     f32,          // offset  4
    spinSpeed:   f32,          // offset  8  — giro en pantalla (rad/s máx.)
    tumbleSpeed: f32,          // offset 12  — volteo fingido en 3D (rad/s)
    startColor:  vec4<f32>,    // offset 16
    endColor:    vec4<f32>,    // offset 32
    atlasCols:   f32,          // offset 48  — variantes de la textura (columnas × filas)
    atlasRows:   f32,          // offset 52
    flutter:     f32,          // offset 56  — vaivén lateral (m)
    nearFade:    f32,          // offset 60  — desvanecer cerca de la cámara (m; 0 = no)
    // total: 64 bytes
};

/// Azar estable por partícula en [0, 1): mezcla el hueco y la vida (que cambia en cada
/// nacimiento), así un hueco reciclado no repite copo.
fn particleRand(index: u32, lifetime: f32, salt: u32) -> f32 {
    var h = index * 747796405u + bitcast<u32>(lifetime) * 2891336453u + salt * 1181783497u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return f32(h) / 4294967296.0;
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;
@group(3) @binding(1) var<uniform>  renderParams: ParticleRenderParams;

// Vertex attributes del quad mesh
struct VertexInput {
    @location(0) position: vec3<f32>, // posición del vértice del quad
    @location(1) normal: vec3<f32>,   // normal del quad (no se usa pero está en el mesh)
    @location(2) uv: vec2<f32>,       // UV del quad
    @location(3) tangent: vec4<f32>,  // tangent del quad (no se usa pero está en el mesh)
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>, // Color interpolado (startColor → endColor)
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    // Obtener la partícula actual usando el instance index
    let particle = particles[input.instanceIndex];

    // OPTIMIZACIÓN CRÍTICA: Skip dead particles generando triángulo degenerado
    if (particle.alive == 0u) {
        var output: VertexOutput;
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Degenerate triangle (w=0)
        output.uv = vec2<f32>(0.0, 0.0);
        output.particleColor = vec4<f32>(0.0);
        return output;
    }

    // t: fracción de vida [0 = recién nacida, 1 = a punto de morir]
    let t = clamp(particle.age / max(particle.lifetime, 0.0001), 0.0, 1.0);

    // Tamaño interpolado
    let size = mix(renderParams.startSize, renderParams.endSize, t);

    // Color interpolado
    let color = mix(renderParams.startColor, renderParams.endColor, t);

    // Billboarding: extraer vectores right y up de las matrices de cámara
    let cameraRight = normalize(vec3<f32>(camera.viewMatrix[0].x, camera.viewMatrix[1].x, camera.viewMatrix[2].x));
    let cameraUp    = normalize(vec3<f32>(camera.viewMatrix[0].y, camera.viewMatrix[1].y, camera.viewMatrix[2].y));

    // Aspecto propio de cada partícula (como la nieve, las hojas o la ceniza de los juegos):
    // ángulo y giro, volteo, variante del atlas y vaivén, todos con su propio azar.
    let age = particle.age;
    let r0 = particleRand(input.instanceIndex, particle.lifetime, 0u);
    let r1 = particleRand(input.instanceIndex, particle.lifetime, 1u);
    let r2 = particleRand(input.instanceIndex, particle.lifetime, 2u);
    let r3 = particleRand(input.instanceIndex, particle.lifetime, 3u);
    let r4 = particleRand(input.instanceIndex, particle.lifetime, 4u);
    let TAU = 6.2831853;

    // Giro: ángulo inicial al azar, sentido al azar, entre la mitad y la velocidad máxima.
    let spinDir = select(-1.0, 1.0, r1 > 0.5);
    let angle = r0 * TAU + spinDir * (0.5 + 0.5 * r2) * renderParams.spinSpeed * age;
    var corner = input.position.xy;
    // Volteo: se achata en un eje como si girase sobre sí misma (nunca del todo: no desaparece).
    if (renderParams.tumbleSpeed > 0.0) {
        let flip = cos(r3 * TAU + (0.6 + 0.8 * r4) * renderParams.tumbleSpeed * age);
        corner.y *= max(abs(flip), 0.15);
    }
    let ca = cos(angle);
    let sa = sin(angle);
    corner = vec2<f32>(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);

    // Calcular offset del vértice del quad en espacio mundo usando billboarding + tamaño
    let quadOffset = (cameraRight * corner.x + cameraUp * corner.y) * size;

    // WORLD SPACE MODE: Las partículas ya están en coordenadas mundiales
    var worldPos = particle.position + quadOffset;

    // Vaivén lateral al caer (horizontal, en una dirección al azar).
    if (renderParams.flutter > 0.0) {
        let swayDir = vec3<f32>(cos(r0 * TAU), 0.0, sin(r0 * TAU));
        let sway = sin(age * (1.2 + 1.3 * r2) + r4 * TAU) + 0.35 * sin(age * (3.1 + 1.7 * r3));
        worldPos += swayDir * sway * renderParams.flutter;
    }

    let clipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);

    // Variante del atlas.
    var uv = input.uv;
    let cols = max(renderParams.atlasCols, 1.0);
    let rows = max(renderParams.atlasRows, 1.0);
    if (cols * rows > 1.0) {
        let cell = floor(r3 * cols * rows);
        let cellXY = vec2<f32>(cell % cols, floor(cell / cols));
        uv = (uv + cellXY) / vec2<f32>(cols, rows);
    }

    // Cerca de la cámara se desvanece (no tapa la vista con manchas enormes).
    var finalColor = color;
    if (renderParams.nearFade > 0.0) {
        let dist = distance(particle.position, camera.cameraPosition.xyz);
        finalColor.a *= smoothstep(renderParams.nearFade * 0.5, renderParams.nearFade, dist);
    }

    var output: VertexOutput;
    output.position    = clipPos;
    output.uv          = uv;
    output.particleColor = finalColor;
    
    return output;
}
