// Screen-Space Temporal Distortion — Quantum Break style
//
// Fullscreen compute pass. Reconstructs world-space position for every pixel
// from gLinearDepth, evaluates up to 8 expanding shockwave spheres stored in
// a UBO, accumulates a screen-space UV offset, and samples accLight at the
// distorted UV. Sky pixels use ray-sphere intersection instead of depth
// reconstruction so the ring is visible against the sky too.
//
// Bind groups:
//   group(0) — CameraUniforms
//   group(1) — accLight (sampled) + sampler + gLinearDepth (sampled)
//   group(2) — outputTex (rgba16float storage write)
//   group(3) — ShockwavesUBO (wave array)

#include "common/uniforms"
#include "common/math/coordinates"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var accLight:     texture_2d<f32>;
@group(1) @binding(1) var samplerScene: sampler;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;

@group(2) @binding(0) var outputTex: texture_storage_2d<rgba16float, write>;

// ── Wave data UBO ─────────────────────────────────────────────────────────────
struct ShockwaveSource {
    origin:    vec3<f32>,
    radius:    f32,
    thickness: f32,
    intensity: f32,
    falloff:   f32,
    _pad:      f32,
}
struct ShockwavesUBO {
    count: u32,
    _p0:   u32, _p1: u32, _p2: u32,
    waves: array<ShockwaveSource, 8>,
}
@group(3) @binding(0) var<uniform> shockwaves: ShockwavesUBO;

// ── FBM Noise (replaces hash22 — much more organic than white noise) ──────────
fn hash21(p: vec2<f32>) -> f32 {
    var p2 = fract(p * vec2<f32>(127.1, 311.7));
    p2 += dot(p2, p2.yx + 19.19);
    return fract((p2.x + p2.y) * p2.x);
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i + vec2<f32>(0.0, 0.0)), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

// 2-octave FBM — returns [-0.5, 0.5]
fn fbm(p: vec2<f32>) -> f32 {
    return valueNoise(p) * 0.667 + valueNoise(p * 2.0 + vec2<f32>(1.7, 9.2)) * 0.333 - 0.5;
}

// Vector FBM with decorrelated axes for curl-like tangential offsets
fn fbmVec(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(fbm(p), fbm(p + vec2<f32>(5.2, 1.3)));
}

// ── Ray-sphere intersection (nearest positive t) ──────────────────────────────
fn raySphereIntersect(ro: vec3<f32>, rd: vec3<f32>,
                      centre: vec3<f32>, radius: f32) -> f32 {
    let oc = ro - centre;
    let b  = dot(oc, rd);
    let c  = dot(oc, oc) - radius * radius;
    let h  = b * b - c;
    if (h < 0.0) { return -1.0; }
    return -b - sqrt(h);
}

// ── Main ──────────────────────────────────────────────────────────────────────
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims  = vec2<i32>(textureDimensions(outputTex));
    let coord = vec2<i32>(gid.xy);
    if (coord.x >= dims.x || coord.y >= dims.y) { return; }

    let uv = (vec2<f32>(coord) + 0.5) / vec2<f32>(dims);

    if (shockwaves.count == 0u) {
        textureStore(outputTex, coord, textureSampleLevel(accLight, samplerScene, uv, 0.0));
        return;
    }

    // ── Depth + world position ────────────────────────────────────────────────
    let depthCoord = clamp(
        vec2<i32>(uv * vec2<f32>(textureDimensions(gLinearDepth))),
        vec2<i32>(0), vec2<i32>(textureDimensions(gLinearDepth)) - vec2<i32>(1),
    );
    let depth  = textureLoad(gLinearDepth, depthCoord, 0).r;
    let isSky  = depth < 0.0001;

    var worldPos: vec3<f32>;
    var rayDir:   vec3<f32>;

    if (!isSky) {
        worldPos = getWorldCoords(uv, depth, camera);
    } else {
        let ndcXY = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
        let vx    = ndcXY.x / camera.projectionMatrix[0][0];
        let vy    = ndcXY.y / camera.projectionMatrix[1][1];
        rayDir    = normalize((camera.invView * vec4<f32>(vx, vy, -1.0, 0.0)).xyz);
    }

    // ── Accumulate UV offset from all active waves ────────────────────────────
    var totalOffset   = vec2<f32>(0.0);
    var totalMask     = 0.0;
    // Weighted world distance used later for the pulse spatial term
    var pulseDist     = 0.0;
    var pulseWeight   = 0.0;

    for (var i = 0u; i < shockwaves.count; i++) {
        let w = shockwaves.waves[i];
        if (w.radius <= 0.0) { continue; }

        var mask:  f32;
        var wPos:  vec3<f32>;

        if (!isSky) {
            let dist = length(worldPos - w.origin);
            let wave = abs(dist - w.radius);
            mask = pow(1.0 - smoothstep(0.0, w.thickness, wave), 2.0);
            wPos = worldPos;
        } else {
            let oc       = camera.cameraPosition.xyz - w.origin;
            let tCA      = max(-dot(oc, rayDir), 0.0);
            if (tCA <= 0.0) { continue; }
            let closest  = camera.cameraPosition.xyz + rayDir * tCA;
            let perpDist = length(closest - w.origin);
            let wave     = abs(perpDist - w.radius);
            mask = pow(1.0 - smoothstep(0.0, w.thickness * 0.5, wave), 2.0);
            wPos = closest;
        }

        if (mask < 0.001) { continue; }

        // ── Outward screen-space directions ───────────────────────────────────
        let radial3d  = normalize(wPos - w.origin);
        let radialSS  = normalize(
            (camera.projectionMatrix * camera.viewMatrix * vec4<f32>(radial3d, 0.0)).xy,
        );
        let tangentSS = vec2<f32>(-radialSS.y, radialSS.x);  // 90° CCW — curl axis

        // ── Depth attenuation using real camera distance (stable, linear) ─────
        let distCam    = select(1.0, length(wPos - camera.cameraPosition.xyz), !isSky);
        let depthAtten = select(1.0, exp(-distCam * w.falloff * 0.08), !isSky);

        // ── FBM noise — organic flow turbulence ───────────────────────────────
        let nCoord = wPos.xz * 0.5 + vec2<f32>(camera.time * 0.06);
        let nVec   = fbmVec(nCoord);       // each component in [-0.5, 0.5]

        // ── Temporal micro-ripples ────────────────────────────────────────────
        let dist2     = length(wPos - w.origin);
        let secondary = sin(dist2 * 8.0 - camera.time * 25.0) * mask * 0.35;
        let flicker   = sin(camera.time * 18.0 + dist2 * 4.0) * 0.0015;

        // ── Fresnel — energy spike at silhouette angles ───────────────────────
        // Grazing view angles relative to the wave's radial direction get boosted.
        // Sky pixels: closest-approach geometry → naturally fresnel≈1 at silhouette.
        let toCamera = normalize(camera.cameraPosition.xyz - wPos);
        let fresnel  = pow(1.0 - abs(dot(toCamera, radial3d)), 3.0);

        // ── Primary radial offset (outward push) ──────────────────────────────
        var waveOff = radialSS * (
              mask * w.intensity
            + secondary * w.intensity * 0.3
            + flicker * mask
        ) * depthAtten;

        waveOff *= (0.5 + fresnel);

        // ── Double refraction: tangential (curl-like) offset ──────────────────
        // The wave doesn't only push outward — it also shears space tangentially.
        // nVec.x drives the curl amplitude independently from the radial noise.
        let tangentOff = tangentSS * nVec.x * mask * depthAtten * w.intensity * 0.5;

        // ── Radial noise turbulence (FBM replaces white-noise hash22) ─────────
        let noiseOff = radialSS * nVec.y * 0.008 * mask * depthAtten;

        totalOffset += waveOff + tangentOff + noiseOff;
        totalMask    = max(totalMask, mask * depthAtten);

        // Accumulate weighted distance for pulse spatial frequency
        pulseDist   += dist2 * mask;
        pulseWeight += mask;
    }

    if (totalMask < 0.001) {
        textureStore(outputTex, coord, textureSampleLevel(accLight, samplerScene, uv, 0.0));
        return;
    }

    // ── Pulse: temporal anomaly oscillation ───────────────────────────────────
    // Modulates total offset so the shockwave pulses like a quantum distortion.
    // pulseDist ≈ w.radius per wave, so frequency naturally rises as wave expands.
    let avgDist = select(0.0, pulseDist / pulseWeight, pulseWeight > 0.001);
    let pulse   = 1.0 + 0.2 * sin(camera.time * 15.0 + avgDist * 3.0);
    totalOffset *= pulse;

    // ── Chromatic aberration: R/G/B at slightly different UV offsets ──────────
    let ca = 0.08;
    let r  = textureSampleLevel(accLight, samplerScene, uv + totalOffset * (1.0 + ca), 0.0).r;
    let g  = textureSampleLevel(accLight, samplerScene, uv + totalOffset,              0.0).g;
    let b  = textureSampleLevel(accLight, samplerScene, uv + totalOffset * (1.0 - ca), 0.0).b;

    textureStore(outputTex, coord, vec4<f32>(r, g, b, 1.0));
}
