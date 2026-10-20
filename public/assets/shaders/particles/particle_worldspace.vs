#include "common/uniforms"
#ifdef LIT
#include "common/core/constants"
#include "common/lighting/csm"
#include "common/probes"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#endif

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
    fogEnabled:  f32,          // offset 64  — LIT: 1 = la niebla volumétrica está activa
    translucency: f32,         // offset 68  — LIT: luz del sol que atraviesa el copo (contraluz)
    _pad0:       f32,
    _pad1:       f32,
    // total: 80 bytes
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

#ifdef LIT
// ── Iluminación por partícula (BindGroupFactory.getParticleLitUniformsLayout) ──
@group(3) @binding(2)  var<uniform> directionalLight: DirectionalLightCSMUniforms;
@group(3) @binding(3)  var shadowMap0: texture_depth_2d;
@group(3) @binding(4)  var shadowMap1: texture_depth_2d;
@group(3) @binding(5)  var shadowMap2: texture_depth_2d;
@group(3) @binding(6)  var shadowSampler: sampler_comparison;
@group(3) @binding(7)  var<storage, read> probeSet: ProbeSet;
@group(3) @binding(8)  var fogVolume: texture_3d<f32>;
@group(3) @binding(9)  var<uniform> froxelParams: FroxelUniforms;
@group(3) @binding(10) var fogSampler: sampler;

fn sunShadow(worldPos: vec3<f32>, viewDepth: f32) -> f32 {
    if (directionalLight.hasShadows < 0.5) { return 1.0; }
    let cascade = selectCascadeCSM(viewDepth, directionalLight.cascadeSplits);
    if (cascade == 0) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset0,
            directionalLight.shadowParams.x, shadowMap0, shadowSampler);
    } else if (cascade == 1) {
        return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset1,
            directionalLight.shadowParams.y, shadowMap1, shadowSampler);
    }
    return getShadowFactorForCascade(worldPos, directionalLight.viewProjOffset2,
        directionalLight.shadowParams.z, shadowMap2, shadowSampler);
}

// Color iluminado de un copo (albedo = color de la partícula) en `center`: sol con su
// sombra (CSM) — difuso de un copo de orientación al azar (½) más el contraluz que lo
// atraviesa (fase HG hacia delante) — y el ambiente de los probes / el cielo.
fn litColor(albedo: vec3<f32>, center: vec3<f32>, viewDepth: f32) -> vec3<f32> {
    let V = normalize(camera.cameraPosition.xyz - center);
    let sunRadiance = directionalLight.color * directionalLight.intensity;
    let cosTheta = dot(V, normalize(-directionalLight.position));
    let forward = phaseHG(cosTheta, 0.6) * 4.0 * PI; // 1 = isótropo
    let sun = sunRadiance * sunShadow(center, viewDepth) * (0.5 + renderParams.translucency * forward);
    // Copo de dos caras: irradiancia hacia la cámara y hacia arriba, promediadas.
    let ambient = (probeIrradiance(center, V).irradiance + probeIrradiance(center, vec3<f32>(0.0, 1.0, 0.0)).irradiance)
                * 0.5 * probeSet.ambientScale;
    return albedo * (sun + ambient) / PI;
}

// Niebla a la profundidad de la partícula: rgb = luz dispersada hasta ella, a = transmitancia.
fn fogAt(clip: vec4<f32>, viewDepth: f32) -> vec4<f32> {
    if (renderParams.fogEnabled < 0.5) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let ndc = clip.xy / clip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let dims = froxelParams.dimensions.xyz;
    let s = froxelDepthToSlice(viewDepth, froxelParams.depthDistScale, froxelParams.depthDistB);
    if (s >= dims.z) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); } // más allá de la rejilla
    // El texel k integra hasta el borde lejano del slice k: profundidad d → s(d) − 1.
    let texelZ = clamp(s - 1.0, 0.0, dims.z - 1.0);
    let f = textureSampleLevel(fogVolume, fogSampler, vec3<f32>(uv, (texelZ + 0.5) / dims.z), 0.0);
    return mix(vec4<f32>(0.0, 0.0, 0.0, 1.0), f, saturate(s));
}
#endif

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
#ifdef LIT
    @location(2) fog: vec4<f32>,           // rgb = dispersión de la niebla, a = transmitancia
#endif
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
#ifdef LIT
        output.fog = vec4<f32>(0.0, 0.0, 0.0, 1.0);
#endif
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
#ifdef LIT
    // Una evaluación por partícula (las 4 esquinas dan lo mismo): en su centro.
    let viewDepth = -(camera.viewMatrix * vec4<f32>(particle.position, 1.0)).z;
    finalColor = vec4<f32>(litColor(finalColor.rgb, particle.position, viewDepth), finalColor.a);
    output.fog = fogAt(camera.projectionMatrix * camera.viewMatrix * vec4<f32>(particle.position, 1.0), viewDepth);
#endif
    output.position    = clipPos;
    output.uv          = uv;
    output.particleColor = finalColor;
    
    return output;
}
