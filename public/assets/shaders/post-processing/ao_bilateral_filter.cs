// Only the two includes actually used by this shader.
// common/structs is NOT needed in a pure compute shader.
#include "common/uniforms"
#include "common/octahedral"

// ---------------------------------------------------------------------------
// AO Bilateral Filter — compute shader
// Converts ao_bilateral_filter.fs to @compute, eliminating the fullscreen-quad
// render pass and using textureSampleLevel (required in compute).
//
// Weights each neighbouring AO sample by depth + normal similarity to preserve
// geometric edges while smoothing noise.
//
// TODO: shared memory tile caching for the AO texture and G-Buffer to reduce
// coalesced texture reads from 147/pixel to ~5/pixel.
// ---------------------------------------------------------------------------

// Filter radius in full-resolution screen pixels
const BILATERAL_RADIUS: i32 = 3;
const BILATERAL_SIGMA_DEPTH: f32  = 0.01;
const BILATERAL_SIGMA_NORMAL: f32 = 0.5;

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var aoTexture: texture_2d<f32>;
@group(2) @binding(1) var samplerAO: sampler;

@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(global_id.xy);

    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    let centerUV = (vec2<f32>(coords) + 0.5) / vec2<f32>(dstSize);

    // Early exit for sky pixels
    let centerDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, centerUV, 0.0).x;
    if (centerDepth > 0.99) {
        textureStore(outputAO, coords, vec4<f32>(1.0, 0.0, 0.0, 1.0));
        return;
    }

    let normalRoughnessData = textureSampleLevel(gNormals, samplerGBuffer, centerUV, 0.0);
    let centerNormal = octahedral01ToNormal(normalRoughnessData.xy);
    let centerAO = textureSampleLevel(aoTexture, samplerAO, centerUV, 0.0).r;

    // Full-resolution texel size — same offsets as the fragment version so the
    // filter kernel radius is identical.
    let texelSize = 1.0 / camera.screenSize;

    var filteredAO   = 0.0;
    var totalWeight  = 0.0;

    for (var x = -BILATERAL_RADIUS; x <= BILATERAL_RADIUS; x++) {
        for (var y = -BILATERAL_RADIUS; y <= BILATERAL_RADIUS; y++) {
            let offset    = vec2<f32>(f32(x), f32(y)) * texelSize;
            let sampleUV  = clamp(centerUV + offset, vec2<f32>(0.0), vec2<f32>(1.0));

            let sampleDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, sampleUV, 0.0).x;
            let sampleNormalData = textureSampleLevel(gNormals, samplerGBuffer, sampleUV, 0.0);
            let sampleNormal = octahedral01ToNormal(sampleNormalData.xy);
            let sampleAO = textureSampleLevel(aoTexture, samplerAO, sampleUV, 0.0).r;

            let depthDiff  = abs(centerDepth - sampleDepth);
            let normalDiff = 1.0 - max(dot(centerNormal, sampleNormal), 0.0);

            let r2 = f32(x * x + y * y);
            let spatialWeight = exp(-r2 / (2.0 * f32(BILATERAL_RADIUS * BILATERAL_RADIUS)));
            let depthWeight   = exp(-depthDiff  / BILATERAL_SIGMA_DEPTH);
            let normalWeight  = exp(-normalDiff / BILATERAL_SIGMA_NORMAL);

            let weight = spatialWeight * depthWeight * normalWeight;
            filteredAO   += sampleAO * weight;
            totalWeight  += weight;
        }
    }

    let result = select(centerAO, filteredAO / totalWeight, totalWeight > 0.0);
    textureStore(outputAO, coords, vec4<f32>(result, 0.0, 0.0, 1.0));
}
