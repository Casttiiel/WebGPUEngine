// Partículas GPU (ParticleSystemComponent): estructuras y utilidades compartidas por los
// compute de spawn/update y el VS. Los layouts deben coincidir con ParticleSystemComponent.ts.

// 48 bytes por partícula.
struct Particle {
    position: vec3<f32>,
    floorY: f32,      // Muere al bajar de esta altura (suelo bajo la ráfaga que la creó)
    velocity: vec3<f32>,
    lifetime: f32,    // Vida total (s)
    age: f32,         // Edad actual (s)
    alive: u32,       // 1 = viva, 0 = muerta
    sizeMul: f32,     // Escala del tamaño de su ráfaga
    trailHead: u32,   // RIBBON: siguiente hueco de su historial (ring buffer)
};

// Parámetros de render (VS + FS). 112 bytes.
struct ParticleRenderParams {
    sizeVariance: f32,     // offset   0 — tamaño entre (1 - v) y (1 + v); la mayoría pequeñas
    spinSpeed: f32,        // offset   4 — giro en pantalla (rad/s máx.)
    tumbleSpeed: f32,      // offset   8 — volteo fingido en 3D (rad/s)
    flutter: f32,          // offset  12 — vaivén lateral (m)
    atlasCols: f32,        // offset  16 — flipbook: columnas × filas
    atlasRows: f32,        // offset  20
    flipbookMode: f32,     // offset  24 — 0 = variante al azar, 1 = a lo largo de la vida, 2 = bucle a fps
    flipbookFps: f32,      // offset  28
    nearFade: f32,         // offset  32 — desvanecer cerca de la cámara (m; 0 = no)
    fogEnabled: f32,       // offset  36 — LIT: 1 = la niebla volumétrica está activa
    translucency: f32,     // offset  40 — LIT: luz del sol que atraviesa la partícula a contraluz
    shape: f32,            // offset  44 — BLOOD: 0 = gota, 1 = neblina
    stretch: f32,          // offset  48 — se alarga en su dirección de movimiento (s de velocidad)
    facing: f32,           // offset  52 — 0 = cámara, 1 = velocidad, 2 = horizontal, 3 = eje fijo
    softDistance: f32,     // offset  56 — soft particles: fundido con la escena (m; 0 = no)
    brightness: f32,       // offset  60 — multiplica el color (HDR: brasas, chispas)
    axis: vec3<f32>,       // offset  64 — facing 3: eje del billboard
    localSpace: f32,       // offset  76 — 1 = partículas en el espacio del emisor (object.modelMatrix)
    trailLength: f32,      // offset  80 — RIBBON: puntos de historial por partícula
    trailInterval: f32,    // offset  84 — RIBBON: s entre puntos
    ribbonWidthTail: f32,  // offset  88 — RIBBON: ancho en la cola (× el de la cabeza)
    ribbonAlphaTail: f32,  // offset  92 — RIBBON: alpha en la cola (× el de la cabeza)
    flipbookBlend: f32,    // offset  96 — 1 = funde frames consecutivos
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    // total: 112 bytes
};

// Curvas a lo largo de la vida, horneadas en la CPU (32 muestras). 640 bytes.
const CURVE_SAMPLES: u32 = 32u;
struct ParticleCurves {
    color: array<vec4<f32>, 32>, // rgba
    size: array<vec4<f32>, 8>,   // 32 escalares empaquetados de 4 en 4
};

fn curveColor(curves: ParticleCurves, t: f32) -> vec4<f32> {
    let x = saturate(t) * f32(CURVE_SAMPLES - 1u);
    let i = u32(floor(x));
    let j = min(i + 1u, CURVE_SAMPLES - 1u);
    return mix(curves.color[i], curves.color[j], x - f32(i));
}

fn curveSizeAt(curves: ParticleCurves, i: u32) -> f32 {
    return curves.size[i >> 2u][i & 3u];
}

fn curveSize(curves: ParticleCurves, t: f32) -> f32 {
    let x = saturate(t) * f32(CURVE_SAMPLES - 1u);
    let i = u32(floor(x));
    let j = min(i + 1u, CURVE_SAMPLES - 1u);
    return mix(curveSizeAt(curves, i), curveSizeAt(curves, j), x - f32(i));
}

/// Azar estable por partícula en [0, 1): mezcla el hueco y la vida (que cambia en cada
/// nacimiento), así un hueco reciclado no repite partícula. salt 5 = el tamaño (VS), y el
/// módulo de luces lo usa para escoger las más grandes.
fn particleRand(index: u32, lifetime: f32, salt: u32) -> f32 {
    var h = index * 747796405u + bitcast<u32>(lifetime) * 2891336453u + salt * 1181783497u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return f32(h) / 4294967296.0;
}
