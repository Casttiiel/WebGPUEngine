#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"
#include "post-processing/ao_common"

// ---------------------------------------------------------------------------
// Screen-Space Ambient Occlusion — compute shader
// Faithful port of three.js SSAONode (examples/jsm/tsl/display/SSAONode.js):
// normalized obscurance with a Vogel disk in the view-aligned plane, rotated per pixel
// with interleaved gradient noise. Self-denoised by the separable depth-aware blur
// in ao_blur.cs (no temporal pass required).
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: AOParams;

@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(global_id.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    let screenCoordinate = vec2<f32>(coords) + 0.5;
    let uv               = screenCoordinate / vec2<f32>(dstSize);

    let depth = aoSampleDepth(uv);
    if (depth >= 1.0) {
        textureStore(outputAO, coords, aoPack(1.0)); // background: no occlusion
        return;
    }

    let viewPosition = aoGetViewPosition(uv, depth);
    let viewNormal   = aoGetViewNormal(uv);

    // A low-discrepancy Vogel disk rotated per pixel decorrelates the samples spatially,
    // so a small blur is enough to hide the sampling pattern.
    let phi = aoInterleavedGradientNoise(screenCoordinate) * TWO_PI;

    let samples = i32(params.samples);
    let radius  = params.radius;

    // The fragment's clip position is loop-invariant; projection is linear, so each
    // sample only has to project its (view-plane) offset and add it.
    let clipPosition = camera.projectionMatrix * vec4<f32>(viewPosition, 1.0);

    var occlusion = 0.0;
    for (var i = 0; i < samples; i++) {
        // Disk offset in the view-aligned plane at the fragment's depth, then reprojected.
        let offset     = aoVogelDiskSample(i, samples, phi) * radius;
        let clipOffset = camera.projectionMatrix * vec4<f32>(offset, 0.0, 0.0);
        let sampleUv   = aoGetScreenPositionFromClip(clipPosition + clipOffset);
        let sampleViewPosition = aoGetViewPosition(sampleUv, aoSampleDepth(sampleUv));

        // Normalized obscurance: only occluders above the tangent plane count, faded by distance.
        let v        = sampleViewPosition - viewPosition;
        let dist     = length(v);
        let cosAngle = dot(v, viewNormal) / max(dist, 0.0001);
        let falloff  = radius / (radius + dist);
        occlusion += max(cosAngle - params.bias, 0.0) * falloff;
    }

    let ao = clamp(1.0 - occlusion / f32(samples) * params.intensity, 0.0, 1.0);
    textureStore(outputAO, coords, aoPack(ao));
}
