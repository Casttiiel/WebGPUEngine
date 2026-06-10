#include "common/uniforms"
#include "common/math/coordinates"
#include "common/core/constants"

// ── Cloud uniforms ─────────────────────────────────────────────────────────────
struct CloudUniforms {
    sunDirection:    vec3f,  // offset   0
    cloudBase:       f32,    // offset  12 → 16
    sunColor:        vec3f,  // offset  16
    cloudTop:        f32,    // offset  28 → 32
    windDirection:   vec3f,  // offset  32
    windOffset:      f32,    // offset  44 → 48
    coverage:        f32,    // offset  48
    density:         f32,    // offset  52
    absorption:      f32,    // offset  56
    scatterStrength: f32,    // offset  60 → 64
    ambientColor:    vec3f,  // offset  64
    cloudFrequency:  f32,    // offset  76 → 80
    stepCount:       f32,    // offset  80
    lightSteps:      f32,    // offset  84
    warpStrength:    f32,    // offset  88
    worleyWeight:    f32,    // offset  92
    fadeRadius:      f32,    // offset  96
    _pad0:           f32,    // offset 100
    _pad1:           f32,    // offset 104
    _pad2:           f32,    // offset 108 → 112
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> u_cloud: CloudUniforms;

// ── Math helpers ───────────────────────────────────────────────────────────────

fn remap(v: f32, inLo: f32, inHi: f32, outLo: f32, outHi: f32) -> f32 {
    return outLo + saturate((v - inLo) / (inHi - inLo)) * (outHi - outLo);
}

fn rayPlaneIntersect(ro: vec3f, rd: vec3f, planeY: f32) -> f32 {
    if (abs(rd.y) < 0.0001) { return -1e9; }
    return (planeY - ro.y) / rd.y;
}

// ── 3D procedural noise ────────────────────────────────────────────────────────

fn hash31(p3_in: vec3f) -> f32 {
    var p = fract(p3_in * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

fn hash33(p3_in: vec3f) -> vec3f {
    var p = fract(p3_in * vec3f(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

fn valueNoise3D(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash31(i + vec3f(0,0,0)), hash31(i + vec3f(1,0,0)), u.x),
            mix(hash31(i + vec3f(0,1,0)), hash31(i + vec3f(1,1,0)), u.x), u.y),
        mix(mix(hash31(i + vec3f(0,0,1)), hash31(i + vec3f(1,0,1)), u.x),
            mix(hash31(i + vec3f(0,1,1)), hash31(i + vec3f(1,1,1)), u.x), u.y),
        u.z
    );
}

fn worley3D(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    var minDist = 1e9;
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            for (var z = -1; z <= 1; z++) {
                let n   = vec3f(f32(x), f32(y), f32(z));
                let r   = hash33(i + n);
                let d   = length(f - (n + r));
                minDist = min(minDist, d);
            }
        }
    }
    return saturate(minDist);
}

fn fbm3D(p: vec3f, octaves: i32) -> f32 {
    var v = 0.0; var amp = 0.5; var q = p;
    for (var i = 0; i < octaves; i++) {
        v += amp * valueNoise3D(q);
        amp *= 0.5;
        q *= 2.1;
    }
    return v;
}

// ── Perlin-Worley y erosión de detalle ────────────────────────────────────────
//
// Perlin puro → bolas suaves y redondas.
// Perlin-Worley → el Worley invertido (1 en centros de celda) erode los blobs
// creando "puffs" con silueta de cúmulo en vez de esferas perfectas.

fn perlinWorley(p: vec3f, worleyW: f32) -> f32 {
    let perlin = valueNoise3D(p);
    let wor    = 1.0 - worley3D(p * 0.85 + vec3f(13.7, 4.2, 7.1));
    return perlin * (1.0 - worleyW) + wor * worleyW;
}

fn fbmShape(p: vec3f, octaves: i32, worleyW: f32) -> f32 {
    var v = 0.0; var amp = 0.5; var q = p;
    for (var i = 0; i < octaves; i++) {
        v += amp * perlinWorley(q, worleyW);
        amp *= 0.5;
        q *= 2.02;
    }
    return v;
}

// 2 octavas de Worley para erosión de bordes tipo cúmulo
fn worleyDetail2(p: vec3f) -> f32 {
    return worley3D(p) * 0.667 + worley3D(p * 2.0) * 0.333;
}

// ── Densidad rápida (solo para el light march) ─────────────────────────────────
// Sin Worley, sin warp — puro FBM value noise de 2 octavas.
// Las sombras propias no necesitan detalle fino.
fn sampleDensityCheap(pos: vec3f) -> f32 {
    let grad = heightGradient_fast(pos);
    if (grad < 0.001) { return 0.0; }
    let wind = vec3f(u_cloud.windDirection.x, 0.0, u_cloud.windDirection.z) * u_cloud.windOffset;
    // Y-drift: lentamente avanza por una nueva "rodaja" del espacio de ruido 3D.
    // El mismo evol que sampleDensity — consistencia de sombras.
    let evol = u_cloud.windOffset * 0.0001;
    let p    = (pos + wind) * u_cloud.cloudFrequency + vec3f(0.0, evol, 0.0);
    let s    = fbm3D(p, 2);
    return max(0.0, remap(s, 1.0 - u_cloud.coverage, 1.0, 0.0, 1.0)) * grad * u_cloud.density;
}

// ── Interleaved Gradient Noise (sin componente temporal para evitar flickering) ─
fn ign(coord: vec2f) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * coord.x + 0.00583715 * coord.y));
}

// ── Cloud density ──────────────────────────────────────────────────────────────

fn heightGradient_fast(pos: vec3f) -> f32 {
    let h = saturate((pos.y - u_cloud.cloudBase) / (u_cloud.cloudTop - u_cloud.cloudBase));
    return smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.65, h);
}

// doDetail=true: full quality (tier 0 only) — adds worleyDetail2 edge erosion (2×worley3D = 54 hash33)
// doDetail=false: mid quality (tier 1) — skips the expensive detail erosion
fn sampleDensity(pos: vec3f, octaves: i32, doDetail: bool) -> f32 {
    let grad = heightGradient_fast(pos);
    if (grad < 0.001) { return 0.0; }

    let wind = vec3f(u_cloud.windDirection.x, 0.0, u_cloud.windDirection.z) * u_cloud.windOffset;
    // evol: parámetro de evolución lento — las formas mutan sin que el jugador lo perciba
    // frame a frame, pero sí lo nota tras varios minutos de juego.
    let evol = u_cloud.windOffset * 0.0001;
    let p    = (pos + wind) * u_cloud.cloudFrequency + vec3f(0.0, evol, 0.0);

    // Domain warp con semillas que derivan a velocidades distintas (×0.71, ×1.0, ×1.37).
    // Cada componente del warp evoluciona a distinto ritmo → las formas grandes y pequeñas
    // se desfasan con el tiempo, dando aspecto de crecimiento y disipación natural.
    let warp = vec3f(fbm3D(p + vec3f(1.7,              9.2 + evol * 0.71, 3.4             ), 2),
                     fbm3D(p + vec3f(8.3 + evol,        2.8,               5.1             ), 2),
                     fbm3D(p + vec3f(4.1,               6.7,               1.3 - evol * 1.37), 2))
             * u_cloud.warpStrength;

    // Forma base: Perlin-Worley con peso de Worley tweakable
    let baseShape = fbmShape(p + warp, octaves, u_cloud.worleyWeight);

    // Coverage con remap suave
    var density = remap(baseShape, 1.0 - u_cloud.coverage, 1.0, 0.0, 1.0) * grad;
    if (density < 0.001) { return 0.0; }

    // Erosión de bordes: solo en tier 0 (cercano) — 2 worley3D = 54 hash33 calls.
    // detailScale normaliza la frecuencia respecto a cloudFrequency para que la erosión
    // mantenga la misma relación espacial con la forma base sea cual sea la frecuencia.
    if (doDetail) {
        let detailScale = 2.5 * (0.00022 / max(u_cloud.cloudFrequency, 0.00001));
        let detail      = worleyDetail2(p * detailScale);
        let edgeFactor  = saturate(1.0 - density / 0.35);
        density        -= edgeFactor * detail * 0.4;
    }

    return max(0.0, density) * u_cloud.density;
}

// ── Iluminación ────────────────────────────────────────────────────────────────

// nSteps: número de pasos del light march (permite reducir por LOD tier)
fn sampleLightingN(pos: vec3f, nSteps: i32) -> f32 {
    let tExit     = rayPlaneIntersect(pos, u_cloud.sunDirection, u_cloud.cloudTop);
    let marchDist = clamp(tExit, 0.0, (u_cloud.cloudTop - u_cloud.cloudBase) * 2.0);
    let stepSize  = marchDist / f32(nSteps);
    if (stepSize < 0.001) { return 1.0; }

    var accumulated = 0.0;
    var p = pos;
    for (var i = 0; i < 12; i++) {
        if (i >= nSteps) { break; }
        accumulated += sampleDensityCheap(p) * stepSize;
        p += u_cloud.sunDirection * stepSize;
    }
    let od = accumulated * u_cloud.absorption;
    // Multiple scattering approximation: primary Beer-Lambert term (direct) +
    // a low-absorption term (simulates light bouncing back from deeper cloud layers).
    // Prevents pitch-black interiors while preserving directionality from sun angle.
    return exp(-od) * 0.7 + exp(-od * 0.25) * 0.3;
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (pow(max(0.001, 1.0 + g2 - 2.0 * g * cosTheta), 1.5) * (4.0 * PI));
}

fn dualLobe(cosTheta: f32) -> f32 {
    return mix(henyeyGreenstein(cosTheta, 0.8), henyeyGreenstein(cosTheta, -0.3), 0.5);
}

fn powderEffect(density: f32, cosTheta: f32) -> f32 {
    let powder = 1.0 - exp(-density * 2.0);
    return mix(1.0, powder, saturate(-cosTheta * 0.5 + 0.5));
}

// ── Ray march principal ────────────────────────────────────────────────────────

fn marchClouds(rayOrigin: vec3f, rayDir: vec3f, dither: f32) -> vec4f {
    let cameraInSlab = rayOrigin.y >= u_cloud.cloudBase && rayOrigin.y <= u_cloud.cloudTop;

    let tBase = rayPlaneIntersect(rayOrigin, rayDir, u_cloud.cloudBase);
    let tTop  = rayPlaneIntersect(rayOrigin, rayDir, u_cloud.cloudTop);

    var tStart = 0.0;
    var tEnd   = 0.0;

    if (cameraInSlab) {
        tStart = 0.0;
        tEnd   = max(0.0, max(tBase, tTop));
        if (tEnd < 0.001) { return vec4f(0.0); }
    } else {
        // Cámara fuera del slab: solo usar los t positivos.
        // Si la cámara está encima y mira hacia abajo, tTop < 0 (plano superior detrás),
        // pero tBase > 0 es válido — el ray viaja de fuera hacia dentro por la base.
        let tA = select(-1.0, tBase, tBase >= 0.0);
        let tB = select(-1.0, tTop,  tTop  >= 0.0);
        if (tA < 0.0 && tB < 0.0) { return vec4f(0.0); } // slab completamente detrás
        tStart = select(tB, min(tA, tB), tA >= 0.0 && tB >= 0.0);
        tEnd   = max(tA, tB);
    }

    if (tEnd <= tStart) { return vec4f(0.0); }

    // ── Distance LOD ──────────────────────────────────────────────────────────
    // Horizontal distance from camera to the ray's entry into the cloud slab.
    let horizLen       = length(rayDir.xz);
    let entryHorizDist = tStart * horizLen;

    // Early-out: completely beyond fade radius
    if (entryHorizDist >= u_cloud.fadeRadius) { return vec4f(0.0); }

    // Quality tier by horizontal entry distance
    // 0 = full (Perlin-Worley + detail erosion)
    // 1 = mid  (Perlin-Worley, fewer octaves, no erosion)
    // 2 = cheap (pure value FBM, same as light march)
    var qualityTier = 0;
    if (entryHorizDist > u_cloud.fadeRadius * 0.45) { qualityTier = 1; }
    if (entryHorizDist > u_cloud.fadeRadius * 0.70) { qualityTier = 2; }

    // distFade is now computed per-step so the cloud dissolves gradually
    // rather than getting multiplied by a single entry-distance factor.

    let cosTheta = dot(rayDir, u_cloud.sunDirection);
    let phase    = dualLobe(cosTheta);

    let nSteps   = i32(clamp(u_cloud.stepCount, 16.0, 128.0));
    let cloudH   = u_cloud.cloudTop - u_cloud.cloudBase;

    // Step size: el mínimo entre dividir el rayo por nSteps y cloudH/16 por componente vertical.
    // Esto evita pasos enormes en rayos casi horizontales que saltan nubes enteras.
    let vertComp = max(abs(rayDir.y), 0.08);
    let maxStep  = cloudH / (16.0 * vertComp);
    let baseStep = min((tEnd - tStart) / f32(nSteps), maxStep);

    // Octave count: fewer for mid tier or distant rays
    var octaves = select(2, 4, tStart < 8000.0);
    if (qualityTier >= 1) { octaves = 2; }

    // Light step count per tier:
    //   Tier 0 (close):  full user-set value
    //   Tier 1 (mid):    capped at 3
    //   Tier 2 (far):    0 — skip light march, use constant approximation
    let nLightSteps    = i32(clamp(u_cloud.lightSteps, 3.0, 12.0));
    let lightStepsTier = select(nLightSteps, 3, qualityTier == 1);

    var transmittance    = 1.0;
    var scatteredLight   = vec3f(0.0);
    var consecutiveEmpty = 0;
    // IGN estático full-range: cada píxel muestrea en una posición diferente dentro del primer
    // paso, rompiendo la correlación entre píxeles adyacentes que causaba los "planos" visibles.
    var t     = tStart + baseStep * dither;
    var iters = 0;

    loop {
        if (t >= tEnd || iters >= 256 || transmittance < 0.01) { break; }
        iters++;

        // Per-step horizontal distance
        let stepHorizDist = t * horizLen;

        // Per-step fade: opacity reduces smoothly from 55 % to 100 % of fadeRadius.
        // Using extinction scale rather than a result multiplier, so the cloud
        // dissolves into transparency (no hard shape discontinuity when tweaking radius).
        let stepFade = 1.0 - saturate((stepHorizDist - u_cloud.fadeRadius * 0.55)
                                      / (u_cloud.fadeRadius * 0.45));
        if (stepFade <= 0.001) { break; } // effectively beyond fade radius — stop marching

        let pos = rayOrigin + rayDir * t;

        // Select density function by LOD tier
        // doDetail=true only for tier 0 (skips 2 worley3D = 54 hash33 for mid/far)
        var density = 0.0;
        if (qualityTier >= 2) {
            density = sampleDensityCheap(pos);
        } else {
            density = sampleDensity(pos, octaves, qualityTier == 0);
        }

        if (density > 0.001) {
            consecutiveEmpty = 0;

            // Scale extinction by stepFade so distant steps contribute less opacity.
            // Both Beer-Lambert and scatter use the same faded extinction — consistent.
            let extinction = density * u_cloud.absorption * stepFade;
            let stepT     = exp(-extinction * baseStep);
            // Physically correct in-scatter: fraction of light absorbed by this step.
            // Always in [0,1] regardless of density or step size — prevents bloom.
            let stepAbsorption = 1.0 - stepT;

            // Tier 2: skip light march entirely — constant ambient sun approximation.
            // Saves 5 sampleDensityCheap calls per step (83 % of the per-step cost).
            var lightEnergy: f32;
            if (qualityTier >= 2) {
                lightEnergy = 0.40;
            } else {
                lightEnergy = sampleLightingN(pos, lightStepsTier);
            }

            // Powder solo tiene sentido con light march real; en tier 2 (aproximación constante)
            // no hay dirección real de luz, así que se omite para evitar silver lining falso.
            let powder = select(1.0, powderEffect(density, cosTheta), qualityTier < 2);

            scatteredLight += transmittance * lightEnergy * phase * powder
                            * u_cloud.sunColor * stepAbsorption * u_cloud.scatterStrength;

            let hFrac      = (pos.y - u_cloud.cloudBase) / cloudH;
            let skyAmbient = u_cloud.ambientColor * (0.3 + 0.7 * hFrac);
            // Ground bounce: tinte terroso modulado por altura del sol para que sea
            // coherente al atardecer/noche (no un naranja brillante a medianoche).
            let sunHCl     = max(0.0, u_cloud.sunDirection.y);
            let groundTint = vec3f(0.6 + sunHCl * 0.3, 0.5 + sunHCl * 0.2, 0.3 + sunHCl * 0.1);
            let gndAmbient = u_cloud.ambientColor * groundTint * (1.0 - hFrac) * 0.15;
            scatteredLight += transmittance * (skyAmbient + gndAmbient) * stepAbsorption * stepFade * 0.5;

            transmittance *= stepT;
            t += baseStep;
        } else {
            // Skip máximo 2× en vacío (era 4×, provocaba saltar nubes enteras)
            consecutiveEmpty++;
            t += baseStep * f32(min(consecutiveEmpty, 2));
        }
    }

    return vec4f(scatteredLight, (1.0 - transmittance));
}

// ── Fragment entry ─────────────────────────────────────────────────────────────

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    let viewDir   = get_view_dir(in.position_clip, camera);
    let worldDir  = normalize(get_world_dir(viewDir, camera));
    let rayOrigin = camera.cameraPosition.xyz;

    // IGN estático — sin componente temporal para evitar flickering sin TAA
    let dither = ign(in.fragCoord.xy);

    let result = marchClouds(rayOrigin, worldDir, dither);
    return result;
}
