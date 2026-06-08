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

// Smooth trilinear value noise — cheap base for FBM
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

// FBM con octave count variable — lejos usa menos octavas
fn fbm3D(p: vec3f, octaves: i32) -> f32 {
    var v = 0.0; var amp = 0.5; var q = p;
    for (var i = 0; i < octaves; i++) {
        v += amp * valueNoise3D(q);
        amp *= 0.5;
        q *= 2.1;
    }
    return v;
}

// 3D Worley (cellular) — vecindario 3x3x3 correcto para evitar artefactos de borde
fn worley3D(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    var minDist = 1e9;
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            for (var z = -1; z <= 1; z++) {
                let n   = vec3f(f32(x), f32(y), f32(z));
                let r   = hash33(i + n);       // feature point dentro de la celda [0,1]³
                let d   = length(f - (n + r)); // distancia al feature point
                minDist = min(minDist, d);
            }
        }
    }
    return saturate(minDist);
}

// ── Cloud density ──────────────────────────────────────────────────────────────

fn heightGradient(pos: vec3f) -> f32 {
    let h = saturate((pos.y - u_cloud.cloudBase) / (u_cloud.cloudTop - u_cloud.cloudBase));
    return smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.65, h);
}

fn sampleDensity(pos: vec3f, octaves: i32) -> f32 {
    let grad = heightGradient(pos);
    if (grad < 0.001) { return 0.0; }

    let wind = vec3f(u_cloud.windDirection.x, 0.0, u_cloud.windDirection.z) * u_cloud.windOffset;
    let p    = (pos + wind) * u_cloud.cloudFrequency;

    // Domain warp — 3 muestras FBM para x, y, z del desplazamiento
    let warp = vec3f(fbm3D(p + vec3f(1.7, 9.2, 3.4), 2),
                     fbm3D(p + vec3f(8.3, 2.8, 5.1), 2),
                     fbm3D(p + vec3f(4.1, 6.7, 1.3), 2)) * 1.2;
    let shape = fbm3D(p + warp, octaves);

    var density = max(0.0, shape - (1.0 - u_cloud.coverage));
    if (density < 0.001) { return 0.0; }

    // Erosión Worley: "popcorn tops" en los cúmulos
    let detail = worley3D(p * 3.5);
    density = remap(density, detail * 0.25, 1.0, 0.0, 1.0);

    return max(0.0, density) * grad * u_cloud.density;
}

// ── Iluminación ────────────────────────────────────────────────────────────────

// 6 pasos Beer-Lambert hacia el sol (sombras propias)
fn sampleLighting(pos: vec3f) -> f32 {
    // Distancia hasta salir del slab en dirección al sol
    let tExit     = rayPlaneIntersect(pos, u_cloud.sunDirection, u_cloud.cloudTop);
    let marchDist = clamp(tExit, 0.0, (u_cloud.cloudTop - u_cloud.cloudBase) * 2.0);
    let stepSize  = marchDist / 6.0;
    if (stepSize < 0.001) { return 1.0; } // sol rasante — sin sombra propia

    var accumulated = 0.0;
    var p = pos;
    for (var i = 0; i < 6; i++) {
        accumulated += sampleDensity(p, 2) * stepSize;
        p += u_cloud.sunDirection * stepSize;
    }
    return exp(-accumulated * u_cloud.absorption);
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (pow(max(0.001, 1.0 + g2 - 2.0 * g * cosTheta), 1.5) * (4.0 * PI));
}

// Dos lóbulos: forward scatter (g=0.8) + back scatter (g=-0.3)
// HG ya está normalizado — no multiplicar por 4π
fn dualLobe(cosTheta: f32) -> f32 {
    return mix(henyeyGreenstein(cosTheta, 0.8), henyeyGreenstein(cosTheta, -0.3), 0.5);
}

// Silver lining: borde brillante cuando el sol está detrás de la nube
fn powderEffect(density: f32, cosTheta: f32) -> f32 {
    let powder = 1.0 - exp(-density * 2.0);
    return mix(1.0, powder, saturate(-cosTheta * 0.5 + 0.5));
}

// ── Ray march principal ────────────────────────────────────────────────────────

fn marchClouds(rayOrigin: vec3f, rayDir: vec3f) -> vec4f {
    let cameraInSlab = rayOrigin.y >= u_cloud.cloudBase && rayOrigin.y <= u_cloud.cloudTop;

    let tBase = rayPlaneIntersect(rayOrigin, rayDir, u_cloud.cloudBase);
    let tTop  = rayPlaneIntersect(rayOrigin, rayDir, u_cloud.cloudTop);

    var tStart = 0.0;
    var tEnd   = 0.0;

    if (cameraInSlab) {
        tStart = 0.0;
        tEnd   = max(0.0, max(tBase, tTop)); // solo planos delante del ray
        if (tEnd < 0.001) { return vec4f(0.0); }
    } else {
        if (tBase < 0.0 || tTop < 0.0) { return vec4f(0.0); }
        tStart = min(tBase, tTop);
        tEnd   = max(tBase, tTop);
    }

    if (tEnd <= tStart) { return vec4f(0.0); }

    let cosTheta = dot(rayDir, u_cloud.sunDirection);
    let phase    = dualLobe(cosTheta);

    // Octavas según distancia — lejano usa menos detalle
    let octaves  = select(2, 4, tStart < 8000.0);
    let baseStep = (tEnd - tStart) / 32.0;

    var transmittance    = 1.0;
    var scatteredLight   = vec3f(0.0);
    var consecutiveEmpty = 0;
    var t     = tStart + baseStep * 0.5;
    var iters = 0;

    // Loop controlado por t (no por iteraciones fijas) para que el adaptive step
    // no consuma iteraciones sin avanzar la distancia correctamente
    loop {
        if (t >= tEnd || iters >= 128 || transmittance < 0.01) { break; }
        iters++;

        let pos     = rayOrigin + rayDir * t;
        let density = sampleDensity(pos, octaves);

        if (density > 0.001) {
            consecutiveEmpty = 0;

            let extinction  = density * u_cloud.absorption;
            let lightEnergy = sampleLighting(pos);
            let powder      = powderEffect(density, cosTheta);
            let stepT       = exp(-extinction * baseStep);

            // Luz directa del sol
            scatteredLight += transmittance * lightEnergy * phase * powder
                            * u_cloud.sunColor * density * baseStep * u_cloud.scatterStrength;

            // Ambient: cielo (frío, arriba) + rebote de suelo (cálido, abajo)
            let hFrac      = (pos.y - u_cloud.cloudBase) / (u_cloud.cloudTop - u_cloud.cloudBase);
            let skyAmbient = u_cloud.ambientColor * (0.3 + 0.7 * hFrac);
            let gndAmbient = u_cloud.ambientColor * vec3f(0.8, 0.7, 0.5) * (1.0 - hFrac) * 0.15;
            let ambient    = (skyAmbient + gndAmbient) * density * baseStep * 0.3;
            scatteredLight += transmittance * ambient;

            transmittance *= stepT;
            t += baseStep;
        } else {
            // Adaptive: hasta 4× el paso base en zonas vacías
            consecutiveEmpty++;
            t += baseStep * f32(min(consecutiveEmpty, 4));
        }
    }

    return vec4f(scatteredLight, 1.0 - transmittance);
}

// ── Fragment entry ─────────────────────────────────────────────────────────────

@fragment
fn fs(@location(0) position_clip: vec3f) -> @location(0) vec4f {
    let viewDir   = get_view_dir(position_clip, camera);
    let worldDir  = normalize(get_world_dir(viewDir, camera));
    let rayOrigin = camera.cameraPosition.xyz;

    let result = marchClouds(rayOrigin, worldDir);
    return result;
}
