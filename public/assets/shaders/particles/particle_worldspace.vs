// Vertex shader de las partículas del ParticleSystemComponent (sprites y ribbons).
//  - Sprites: un quad por partícula, orientado según `facing` (cámara, velocidad,
//    horizontal o eje fijo), con giro, volteo, aleteo y flipbook.
//  - RIBBON: una tira por partícula que une su posición con su historial (estela).
// Color y tamaño salen de las curvas de vida horneadas (ParticleCurves).
// Defines: LIT (sol + sombras + probes + niebla por partícula), BLOOD (datos para su FS).
#include "common/uniforms"
#include "common/particles"
#ifdef LIT
#include "common/core/constants"
#include "common/lighting/csm"
#include "common/probes"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#endif

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var<storage, read> particles: array<Particle>;
@group(3) @binding(1) var<uniform>  renderParams: ParticleRenderParams;
#ifdef RIBBON
@group(3) @binding(12) var<storage, read> trailHistory: array<vec4<f32>>;
#endif
@group(3) @binding(13) var<uniform> curves: ParticleCurves;

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

// Vertex attributes de la malla (quad del sprite, o la tira del ribbon: position.x = lado
// [-0.5, 0.5], position.y = índice del punto de la estela).
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>, // Color de la curva de vida
#ifdef LIT
    @location(2) fog: vec4<f32>,           // rgb = dispersión de la niebla, a = transmitancia
#endif
#ifdef BLOOD
    @location(3) sunLocal: vec3<f32>,      // dirección al sol en la base del quad (x, y, hacia la cámara)
    @location(4) sunLight: vec3<f32>,      // radiancia del sol con su sombra
    @location(5) misc: vec4<f32>,          // azar, fracción de vida, forma, largo / ancho
#endif
    @location(6) extra: vec4<f32>,         // xy = uv del frame siguiente, z = fundido, w = profundidad de vista
};

/// Del espacio de las partículas al mundo (solo las de local space viven en el del emisor).
fn toWorld(p: vec3<f32>) -> vec3<f32> {
    if (renderParams.localSpace > 0.5) { return (object.modelMatrix * vec4<f32>(p, 1.0)).xyz; }
    return p;
}

fn toWorldDir(v: vec3<f32>) -> vec3<f32> {
    if (renderParams.localSpace > 0.5) { return (object.modelMatrix * vec4<f32>(v, 0.0)).xyz; }
    return v;
}

#ifdef RIBBON
/// Punto k de la estela en el mundo: 0 = la partícula ahora; 1..N = su historial, del más nuevo al más viejo.
fn trailPoint(index: u32, particle: Particle, k: u32) -> vec3<f32> {
    if (k == 0u) { return toWorld(particle.position); }
    let N = u32(renderParams.trailLength);
    return toWorld(trailHistory[index * N + (particle.trailHead + N - k) % N].xyz);
}
#endif

/// Celda `frame` del atlas → uv.
fn atlasUV(uv: vec2<f32>, frame: f32, cols: f32, rows: f32) -> vec2<f32> {
    let cell = vec2<f32>(frame - cols * floor(frame / cols), floor(frame / cols));
    return (uv + cell) / vec2<f32>(cols, rows);
}

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    let index = input.instanceIndex;
    let particle = particles[index];

    var output: VertexOutput;
    // Muertas: triángulo degenerado (w = 0).
    if (particle.alive == 0u) {
        output.position = vec4<f32>(0.0);
        output.uv = vec2<f32>(0.0);
        output.particleColor = vec4<f32>(0.0);
        output.extra = vec4<f32>(0.0);
#ifdef LIT
        output.fog = vec4<f32>(0.0, 0.0, 0.0, 1.0);
#endif
#ifdef BLOOD
        output.sunLocal = vec3<f32>(0.0);
        output.sunLight = vec3<f32>(0.0);
        output.misc = vec4<f32>(0.0);
#endif
        return output;
    }

    // t: fracción de vida [0 = recién nacida, 1 = a punto de morir]
    let t = clamp(particle.age / max(particle.lifetime, 0.0001), 0.0, 1.0);

    // Tamaño de la curva (por la escala de su ráfaga y su variación propia)
    let sizeRand = particleRand(index, particle.lifetime, 5u);
    let sv = renderParams.sizeVariance;
    let size = curveSize(curves, t) * particle.sizeMul * ((1.0 - sv) + 2.0 * sv * sizeRand * sizeRand);

    var color = curveColor(curves, t);

    // Azar propio de cada partícula: ángulo y giro, volteo, variante del atlas y vaivén.
    let age = particle.age;
    let r0 = particleRand(index, particle.lifetime, 0u);
    let r1 = particleRand(index, particle.lifetime, 1u);
    let r2 = particleRand(index, particle.lifetime, 2u);
    let r3 = particleRand(index, particle.lifetime, 3u);
    let r4 = particleRand(index, particle.lifetime, 4u);
    let TAU = 6.2831853;

    var center = toWorld(particle.position);
    var axisX: vec3<f32>;
    var axisY: vec3<f32>;
    var lengthY = size;
    var worldPos: vec3<f32>;
    var uv = input.uv;
    var extraUV = vec3<f32>(input.uv, 0.0);
    var toCamera = normalize(camera.cameraPosition.xyz - center);

#ifdef RIBBON
    // ── Ribbon: la tira une la partícula con su historial ──
    let N = u32(renderParams.trailLength);
    let k = min(u32(input.position.y + 0.5), N);
    let pk = trailPoint(index, particle, k);
    var tangent = trailPoint(index, particle, max(k, 1u) - 1u) - trailPoint(index, particle, min(k + 1u, N));
    if (dot(tangent, tangent) < 1e-10) { tangent = toWorldDir(particle.velocity); }
    if (dot(tangent, tangent) < 1e-10) { tangent = vec3<f32>(0.0, 1.0, 0.0); }
    tangent = normalize(tangent);
    center = pk;
    toCamera = normalize(camera.cameraPosition.xyz - pk);
    var side = cross(tangent, toCamera);
    side = select(cross(tangent, vec3<f32>(0.0, 1.0, 0.0)), side, dot(side, side) > 1e-8);
    axisX = normalize(side);
    axisY = tangent;
    // Cada punto tiene el color de la edad que tenía al pasar por ahí: la cola "enfría".
    let fk = f32(k) / f32(max(N, 1u));
    let tk = clamp((age - f32(k) * renderParams.trailInterval) / max(particle.lifetime, 0.0001), 0.0, 1.0);
    color = curveColor(curves, tk);
    color.a *= mix(1.0, renderParams.ribbonAlphaTail, fk);
    let width = size * mix(1.0, renderParams.ribbonWidthTail, fk);
    worldPos = pk + axisX * input.position.x * width;
    uv = vec2<f32>(fk, input.uv.y);
    extraUV = vec3<f32>(uv, 0.0);
#else
    // ── Sprite ──
    let facing = u32(renderParams.facing + 0.5);
    // Giro: ángulo inicial al azar, sentido al azar, entre la mitad y la velocidad máxima.
    let spinDir = select(-1.0, 1.0, r1 > 0.5);
    let angle = r0 * TAU + spinDir * (0.5 + 0.5 * r2) * renderParams.spinSpeed * age;
    let ca = cos(angle);
    let sa = sin(angle);
    var corner = input.position.xy;
    // Volteo: se achata en un eje como si girase sobre sí misma (nunca del todo: no desaparece).
    if (renderParams.tumbleSpeed > 0.0) {
        let flip = cos(r3 * TAU + (0.6 + 0.8 * r4) * renderParams.tumbleSpeed * age);
        corner.y *= max(abs(flip), 0.15);
    }

    if (facing == 2u) {
        // Horizontal: tumbado en el plano XZ (anillos de impacto, ondas en el suelo), gira en Y.
        axisX = vec3<f32>(ca, 0.0, sa);
        axisY = vec3<f32>(-sa, 0.0, ca);
    } else if (facing == 3u) {
        // Eje fijo: Y sigue el eje y X mira a la cámara (rayos, columnas, llamas altas).
        var ax = toWorldDir(renderParams.axis);
        ax = select(vec3<f32>(0.0, 1.0, 0.0), normalize(ax), dot(ax, ax) > 1e-8);
        let sideAxis = cross(ax, toCamera);
        axisY = ax;
        axisX = select(vec3<f32>(1.0, 0.0, 0.0), normalize(sideAxis), dot(sideAxis, sideAxis) > 1e-8);
    } else {
        // Cámara: los ejes de la vista girados `angle`.
        let cameraRight = normalize(vec3<f32>(camera.viewMatrix[0].x, camera.viewMatrix[1].x, camera.viewMatrix[2].x));
        let cameraUp    = normalize(vec3<f32>(camera.viewMatrix[0].y, camera.viewMatrix[1].y, camera.viewMatrix[2].y));
        axisX = cameraRight * ca + cameraUp * sa;
        axisY = cameraUp * ca - cameraRight * sa;
        // Velocidad (o cámara con stretch): Y sigue el movimiento visto desde la cámara y se
        // alarga lo que recorre en `stretch` s; la estela queda detrás.
        if (facing == 1u || renderParams.stretch > 0.0) {
            let velocity = toWorldDir(particle.velocity);
            let onScreen = velocity - toCamera * dot(velocity, toCamera);
            let speed = length(onScreen);
            if (speed > 1e-3) {
                axisY = onScreen / speed;
                axisX = normalize(cross(axisY, toCamera));
                let extra = speed * renderParams.stretch;
                lengthY = size + extra;
                center -= axisY * extra * 0.5;
            }
        }
    }

    worldPos = center + axisX * corner.x * size + axisY * corner.y * lengthY;

    // Vaivén lateral al caer (horizontal, en una dirección al azar).
    if (renderParams.flutter > 0.0) {
        let swayDir = vec3<f32>(cos(r0 * TAU), 0.0, sin(r0 * TAU));
        let sway = sin(age * (1.2 + 1.3 * r2) + r4 * TAU) + 0.35 * sin(age * (3.1 + 1.7 * r3));
        worldPos += swayDir * sway * renderParams.flutter;
    }

    // Flipbook: variante al azar, a lo largo de la vida o en bucle; con fundido entre frames.
    let cols = max(renderParams.atlasCols, 1.0);
    let rows = max(renderParams.atlasRows, 1.0);
    let frames = cols * rows;
    if (frames > 1.0) {
        let mode = u32(renderParams.flipbookMode + 0.5);
        let blend = renderParams.flipbookBlend > 0.5 && mode != 0u;
        var f: f32;
        if (mode == 1u) {
            f = select(min(floor(t * frames), frames - 1.0), t * (frames - 1.0), blend);
        } else if (mode == 2u) {
            f = age * renderParams.flipbookFps + floor(r3 * frames);
        } else {
            f = floor(r3 * frames);
        }
        let f0 = floor(f);
        let f1 = select(f0 + 1.0, min(f0 + 1.0, frames - 1.0), mode == 1u);
        uv = atlasUV(input.uv, f0 - frames * floor(f0 / frames), cols, rows);
        extraUV = vec3<f32>(atlasUV(input.uv, f1 - frames * floor(f1 / frames), cols, rows), select(0.0, f - f0, blend));
    }
#endif

    color = vec4<f32>(color.rgb * renderParams.brightness, color.a);

    // Cerca de la cámara se desvanece (no tapa la vista con manchas enormes).
    if (renderParams.nearFade > 0.0) {
        let dist = distance(center, camera.cameraPosition.xyz);
        color.a *= smoothstep(renderParams.nearFade * 0.5, renderParams.nearFade, dist);
    }

    let clipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let vertexViewDepth = -(camera.viewMatrix * vec4<f32>(worldPos, 1.0)).z;

#ifdef LIT
    // Una evaluación por partícula (o por punto de la estela): en su centro.
    let viewDepth = -(camera.viewMatrix * vec4<f32>(center, 1.0)).z;
    color = vec4<f32>(litColor(color.rgb, center, viewDepth), color.a);
    output.fog = fogAt(camera.projectionMatrix * camera.viewMatrix * vec4<f32>(center, 1.0), viewDepth);
#endif
#ifdef BLOOD
    // Para el brillo húmedo del FS: el sol en la base del quad y cuánto llega (con sombra).
    let toSun = normalize(directionalLight.position);
    output.sunLocal = vec3<f32>(dot(toSun, axisX), dot(toSun, axisY), dot(toSun, toCamera));
    output.sunLight = directionalLight.color * directionalLight.intensity * sunShadow(center, viewDepth);
    output.misc = vec4<f32>(r0, t, renderParams.shape, lengthY / max(size, 1e-4));
#endif
    output.position = clipPos;
    output.uv = uv;
    output.particleColor = color;
    output.extra = vec4<f32>(extraUV, vertexViewDepth);
    return output;
}
