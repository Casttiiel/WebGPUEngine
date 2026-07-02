// ─── Volumetric Box Fog — Mesh Ray-March ──────────────────────────────────────
//
// Uniform-density fog inside a box mesh.
// Blend mode "volumetric": finalColor = scatter + scene * transmittance

#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera:  CameraUniforms;

@group(1) @binding(0) var txBlueNoise:      texture_2d<f32>;
@group(1) @binding(1) var txLinearDepth:    texture_2d<f32>;
@group(1) @binding(2) var fogSampler:       sampler;
@group(1) @binding(3) var<uniform> fp:      VolumetricFogParams;

struct VolumetricFogParams {
    fogColor:      vec3<f32>,  // offset  0  (baseColorFactor.rgb)
    density:       f32,        // offset 12  (baseColorFactor.a)
    _pad0:         vec4<f32>,  // offset 16  (unused)
    noiseScale:    f32,        // offset 32  (uvXScale)
    noiseStrength: f32,        // offset 36  (uvYScale)  0=uniform 1=full banks
    windSpeed:     f32,        // offset 40  (surfaceBlend)
    _pad1:         f32,        // offset 44  (pomScale)
}

fn h31(p: vec3<f32>) -> f32 {
    var h = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    h += dot(h, h.yzx + 33.33);
    return fract((h.x + h.y) * h.z);
}

fn vnoise(p: vec3<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(h31(i),             h31(i+vec3(1,0,0)), u.x),
            mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), u.x), u.y),
        mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), u.x),
            mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), u.x), u.y),
        u.z,
    );
}

// Low-frequency FBM used for domain warping (2 octaves is enough for the warp)
fn fbmLow(p: vec3<f32>) -> f32 {
    var n  = vnoise(p)                              * 0.500;
    n     += vnoise(p * 2.1 + vec3(1.7, 9.2, 3.4)) * 0.500;
    return n;
}

// Domain-warped mist density — Inigo Quilez technique.
// A first FBM curls the sample coordinates, producing the flowing wisps
// and organic tendrils characteristic of real mist.
fn mistDensity(pWS: vec3<f32>) -> f32 {
    let wind = vec3<f32>(fp.windSpeed * camera.time, 0.0, fp.windSpeed * 0.4 * camera.time);

    // Flatten Y strongly: mist is wide horizontal layers, not spherical blobs
    let p = vec3<f32>(
        (pWS.x + wind.x) * fp.noiseScale,
         pWS.y            * fp.noiseScale * 0.12,
        (pWS.z + wind.z)  * fp.noiseScale,
    );

    // Domain warp: offset coordinates by a low-freq noise field
    let warpX = fbmLow(p);
    let warpZ = fbmLow(p + vec3(5.2, 1.3, 4.7));
    let warpY = fbmLow(p + vec3(3.1, 6.8, 2.0)) * 0.15;
    let warped = p + vec3(warpX, warpY, warpZ) * 0.9;

    // Main density sampled at warped coords — wispy organic shapes
    var n  = vnoise(warped)                              * 0.500;
    n     += vnoise(warped * 2.2 + vec3(2.1, 0.0, 8.9)) * 0.250;
    n     += vnoise(warped * 4.5 + vec3(7.4, 3.3, 1.6)) * 0.125;

    // Smooth remap: mist has gentle gradients, not hard banks
    let raw = smoothstep(0.1, 0.85, n);

    return mix(1.0, raw, fp.noiseStrength);
}

fn worldDirToOS(d: vec3<f32>, c0: vec3<f32>, c1: vec3<f32>, c2: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dot(d, c0) / dot(c0, c0),
        dot(d, c1) / dot(c1, c1),
        dot(d, c2) / dot(c2, c2),
    );
}

fn rayUnitBox(ro: vec3<f32>, rd: vec3<f32>) -> vec2<f32> {
    let inv = 1.0 / rd;
    let t0  = (-0.5 - ro) * inv;
    let t1  = ( 0.5 - ro) * inv;
    let mn  = min(t0, t1);
    let mx  = max(t0, t1);
    return vec2<f32>(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}

const NUM_STEPS: i32 = 24;

@fragment
fn fs(
    @builtin(position)     fragCoord: vec4<f32>,
    @builtin(front_facing) isFront:   bool,
    @location(0)           worldPos:  vec3<f32>,
    @location(1)           roOS:      vec3<f32>,
    @location(2)           col0:      vec3<f32>,
    @location(3)           col1:      vec3<f32>,
    @location(4)           col2:      vec3<f32>,
) -> @location(0) vec4<f32> {

    let rayWS = normalize(worldPos - camera.cameraPosition.xyz);
    let rdOS  = worldDirToOS(rayWS, col0, col1, col2);

    let tb    = rayUnitBox(roOS, rdOS);
    let tFar  = tb.y;
    let tNear = tb.x;

    if (tFar <= max(tNear, 0.0)) { discard; }

    let cameraInside = tNear < 0.0;
    if (isFront == cameraInside) { discard; }

    let tStart = max(tNear, 0.0);

    let depthCoord = vec2<i32>(i32(fragCoord.x), i32(fragCoord.y));
    let tScene     = textureLoad(txLinearDepth, depthCoord, 0).r * camera.cameraFar;
    let tEnd       = min(tFar, tScene);

    if (tEnd <= tStart) { discard; }

    let noiseUV  = fract(fragCoord.xy / 64.0);
    let dither   = textureSampleLevel(txBlueNoise, fogSampler, noiseUV, 0.0).r;
    let stepSize = (tEnd - tStart) / f32(NUM_STEPS);

    var scatter       = vec3<f32>(0.0);
    var transmittance = 1.0;

    for (var i = 0i; i < NUM_STEPS; i++) {
        let tSample = tStart + (f32(i) + dither) * stepSize;
        if (tSample >= tEnd) { break; }

        let pWS     = camera.cameraPosition.xyz + rayWS * tSample;
        let noise   = mistDensity(pWS);
        let extinct = exp(-fp.density * noise * stepSize);
        let weight  = transmittance * (1.0 - extinct);

        scatter       += fp.fogColor * weight;
        transmittance *= extinct;

        if (transmittance < 0.004) { break; }
    }

    return vec4<f32>(scatter, transmittance);
}
