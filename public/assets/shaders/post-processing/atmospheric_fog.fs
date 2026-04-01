#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

struct AtmosphericFogParams {
    fogColor:     vec4<f32>,  // rgb = color base, w = density
    fogHeight:    vec4<f32>,  // x = heightStart, y = heightEnd, z = falloff,   w = pad
    distanceFog:  vec4<f32>,  // x = start,       y = end,       z = exponent,  w = pad
    nearFogColor: vec4<f32>,  // rgb = near color, w = pad
    nearFogRange: vec4<f32>,  // x = start,        y = end,      zw = pad
    mipFog:       vec4<f32>,  // x = start,        y = end,      z = maxMip,    w = strength
    globalBoost:  vec4<f32>,  // x = globalAmbientBoost,         yzw = pad
}

@group(2) @binding(0) var<uniform> params:    AtmosphericFogParams;
@group(2) @binding(1) var sceneColor:         texture_2d<f32>;
@group(2) @binding(2) var texSampler:         sampler;
@group(2) @binding(3) var txEnvironment:      texture_cube<f32>;
@group(2) @binding(4) var envSampler:         sampler;

// Distance fog factor: [0, 1] where 1 = fully occluded by fog.
// distanceExponent controls the curve shape: 1.0 = linear, 2.0 = exponential squared.
fn distanceFogFactor(dist: f32) -> f32 {
    let t = saturate(
        (dist - params.distanceFog.x) /
        max(params.distanceFog.y - params.distanceFog.x, 0.001)
    );
    return pow(t, params.distanceFog.z);
}

// Height fog factor: 1.0 at or below fogHeightEnd, fades to 0 at fogHeightStart.
// Multiply with distanceFog — fog is maximum when far AND low.
fn heightFogFactor(posWS: vec3<f32>) -> f32 {
    let t = saturate(
        (posWS.y - params.fogHeight.y) /
        max(params.fogHeight.x - params.fogHeight.y, 0.001)
    );
    return pow(max(0.0, 1.0 - t), params.fogHeight.z);
}

// Naughty Dog inverted mip-fog: fog colour ALWAYS derived from the sky cubemap.
//   Near (dist=0):             mip = maxMip  → fully blurred = average sky tone.
//                                              Dark at night, bright at day — adapts automatically.
//   Far  (dist = mipFog.y):    mip = 0       → directional sky colour matching the skybox.
// mipFog.x = fade-in start, mipFog.y = full-range distance, mipFog.z = maxMip, mipFog.w = strength.
fn getMipFogColor(posWS: vec3<f32>, dist: f32) -> vec3<f32> {
    let dir = normalize(posWS - camera.cameraPosition.xyz);
    // t: 0 at mipFog.x, 1 at mipFog.y.  Below mipFog.x the fog stays at maxMip (avg colour).
    let t   = saturate(
        (dist - params.mipFog.x) /
        max(params.mipFog.y - params.mipFog.x, 0.001)
    );
    // Inverted: near → maxMip (blurry/ambient), far → 0 (directional/vivid).
    let mip = params.mipFog.z * (1.0 - t);
    return textureSampleLevel(txEnvironment, envSampler, dir, mip).rgb
           * params.globalBoost.x;
}

// Near fog color override blends nearFogColor toward baseFogColor as distance increases.
// Inlined in fs() — nearFogBlend is no longer a separate function.

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let scene = textureSampleLevel(sceneColor, texSampler, uv, 0.0).rgb;

    let g = decodeGBuffer(uv);

    // Sky pixels: no fog (return scene as-is so skybox is unaffected)
    if (g.zlinear >= 0.999) {
        return vec4<f32>(scene, 1.0);
    }

    let posWS        = g.worldPos;
    let distToCamera = length(posWS - camera.cameraPosition.xyz);

    // Fog factor: distance × height × global density
    let distFactor   = distanceFogFactor(distToCamera);
    let heightFactor = heightFogFactor(posWS);
    let fogFactor    = saturate(distFactor * heightFactor * params.fogColor.w);

    // Fog colour: always sky-derived (inverted mip formula).
    // mipFog.w blends between scene fog colour and sky fog for overall strength control.
    let skyFogCol  = getMipFogColor(posWS, distToCamera);
    let fogCol     = mix(params.fogColor.rgb, skyFogCol, params.mipFog.w);

    // Final blend: scene → fogColor
    let finalColor = mix(scene, fogCol, fogFactor);
    return vec4<f32>(finalColor, 1.0);
}
