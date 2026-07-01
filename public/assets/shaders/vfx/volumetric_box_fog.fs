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

// 48-byte layout matching MaterialFactors (only fogColor and density used)
struct VolumetricFogParams {
    fogColor: vec3<f32>,  // offset  0  (baseColorFactor.rgb)
    density:  f32,        // offset 12  (baseColorFactor.a)
    _pad0:    vec4<f32>,  // offset 16  (roughness/metallic/emissive/appearanceBlend)
    _pad1:    vec4<f32>,  // offset 32  (uvXScale/uvYScale/surfaceBlend/pomScale)
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

        let extinct = exp(-fp.density * stepSize);
        let weight  = transmittance * (1.0 - extinct);

        scatter       += fp.fogColor * weight;
        transmittance *= extinct;

        if (transmittance < 0.004) { break; }
    }

    return vec4<f32>(scatter, transmittance);
}
