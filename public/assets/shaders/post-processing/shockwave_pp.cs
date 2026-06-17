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
    origin:    vec3<f32>,   // world-space centre of the wave
    radius:    f32,         // current radius (metres), updated each frame from CPU
    thickness: f32,         // ring width in metres  (e.g. 2.5)
    intensity: f32,         // UV warp amplitude     (e.g. 0.04)
    falloff:   f32,         // depth-attenuation factor exp(-depth * falloff)
    _pad:      f32,
}
struct ShockwavesUBO {
    count: u32,
    _p0:   u32, _p1: u32, _p2: u32,
    waves: array<ShockwaveSource, 8>,
}
@group(3) @binding(0) var<uniform> shockwaves: ShockwavesUBO;

// ── Hash noise ────────────────────────────────────────────────────────────────
fn hash22(p: vec2<f32>) -> vec2<f32> {
    var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.xx + p3.yz) * p3.zy);
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

    // Fast path: skip entirely when no active waves
    if (shockwaves.count == 0u) {
        textureStore(outputTex, coord, textureSampleLevel(accLight, samplerScene, uv, 0.0));
        return;
    }

    // ── Depth + world position ────────────────────────────────────────────────
    let depthCoord = clamp(
        vec2<i32>(uv * vec2<f32>(textureDimensions(gLinearDepth))),
        vec2<i32>(0), vec2<i32>(textureDimensions(gLinearDepth)) - vec2<i32>(1)
    );
    let depth  = textureLoad(gLinearDepth, depthCoord, 0).r;
    let isSky  = depth < 0.0001;

    var worldPos: vec3<f32>;
    var rayDir:   vec3<f32>;

    if (!isSky) {
        worldPos = getWorldCoords(uv, depth, camera);
    } else {
        // Reconstruct view-space ray direction for sphere intersection
        let ndcXY = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
        let vx    = ndcXY.x / camera.projectionMatrix[0][0];
        let vy    = ndcXY.y / camera.projectionMatrix[1][1];
        rayDir    = normalize((camera.invView * vec4<f32>(vx, vy, -1.0, 0.0)).xyz);
    }

    // ── Accumulate UV offset from all active waves ────────────────────────────
    var totalOffset = vec2<f32>(0.0);
    var totalMask   = 0.0;

    for (var i = 0u; i < shockwaves.count; i++) {
        let w = shockwaves.waves[i];
        if (w.radius <= 0.0) { continue; }

        var mask:  f32;
        var wPos:  vec3<f32>;  // world position used for noise / direction

        if (!isSky) {
            // ── Geometry pixel: exact world-space ring mask ───────────────────
            let dist = length(worldPos - w.origin);
            let wave = abs(dist - w.radius);
            mask = pow(1.0 - smoothstep(0.0, w.thickness, wave), 2.0);
            wPos = worldPos;
        } else {
            // ── Sky pixel: perpendicular-distance ring mask ───────────────────
            // Use the perpendicular distance from the camera ray to the sphere
            // centre. The ring is visible where perpDist ≈ w.radius (tangent
            // rays at the sphere silhouette).
            let oc  = camera.cameraPosition.xyz - w.origin;
            let tCA = max(-dot(oc, rayDir), 0.0);    // closest-approach parameter
            if (tCA <= 0.0) { continue; }            // sphere behind camera
            let closest = camera.cameraPosition.xyz + rayDir * tCA;
            let perpDist = length(closest - w.origin);
            let wave = abs(perpDist - w.radius);
            mask = pow(1.0 - smoothstep(0.0, w.thickness * 0.5, wave), 2.0);
            wPos = closest;
        }

        if (mask < 0.001) { continue; }

        // ── Outward screen-space direction ────────────────────────────────────
        let radial3d = normalize(wPos - w.origin);
        let radialSS = normalize(
            (camera.projectionMatrix * camera.viewMatrix * vec4<f32>(radial3d, 0.0)).xy
        );

        // ── Depth attenuation (closer pixels = stronger effect) ───────────────
        let depthAtten = select(1.0, exp(-depth * w.falloff), !isSky);

        // ── Temporal micro-ripples ────────────────────────────────────────────
        let dist2     = length(wPos - w.origin);
        let secondary = sin(dist2 * 8.0 - camera.time * 25.0) * mask * 0.35;
        let flicker   = sin(camera.time * 18.0 + dist2 * 4.0) * 0.0015;

        // ── Noise turbulence ──────────────────────────────────────────────────
        let n       = hash22(wPos.xz * 0.8 + vec2<f32>(camera.time * 0.08));
        let noiseOff = (n * 2.0 - vec2<f32>(1.0)) * 0.006 * mask * depthAtten;

        // ── Compose offset for this wave ──────────────────────────────────────
        let waveOff = radialSS * (
              mask * w.intensity
            + secondary * w.intensity * 0.3
            + flicker   * mask
        ) * depthAtten;

        totalOffset += waveOff + noiseOff;
        totalMask    = max(totalMask, mask * depthAtten);
    }

    // Pass-through: no wave covering this pixel
    if (totalMask < 0.001) {
        textureStore(outputTex, coord, textureSampleLevel(accLight, samplerScene, uv, 0.0));
        return;
    }

    // ── Chromatic aberration: split R/G/B with slightly different UV offsets ──
    let ca = 0.08;
    let r  = textureSampleLevel(accLight, samplerScene, uv + totalOffset * (1.0 + ca), 0.0).r;
    let g  = textureSampleLevel(accLight, samplerScene, uv + totalOffset,              0.0).g;
    let b  = textureSampleLevel(accLight, samplerScene, uv + totalOffset * (1.0 - ca), 0.0).b;

    textureStore(outputTex, coord, vec4<f32>(r, g, b, 1.0));
}
