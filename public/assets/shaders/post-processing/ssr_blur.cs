// SSR Spatial Blur — compute shader
// Single-pass cross-bilateral filter applied after the SSR ray march.
// Purpose:
//   • Hides individual march steps still visible at low step counts.
//   • Simulates roughness-driven reflection blur:
//       roughness → 0   → kernel radius → 0 (sharp mirror, no blur needed)
//       roughness → 0.6 → kernel radius → 4 px (blurry reflection)
// Cross-bilateral weight: depth-aware, only averages samples at similar depth
// to avoid bleeding across silhouettes.
//
// Bind-group layout:
//   group(0)  SSR raw result   (texture_2d<f32>  read)
//   group(1)  G-Buffer normals + depth for bilateral weights
//   group(2)  Output storage   (texture_storage_2d<rgba16float, write>)

#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var ssrRaw:        texture_2d<f32>;
@group(0) @binding(1) var samplerLinear: sampler;

@group(1) @binding(0) var gNormals:      texture_2d<f32>;
@group(1) @binding(1) var gLinearDepth:  texture_2d<f32>;
@group(1) @binding(2) var samplerPoint:  sampler;

@group(2) @binding(0) var outputBlurred: texture_storage_2d<rgba16float, write>;

// 13-tap Gaussian weights (sigma ≈ 2) — reused for both axes via separable kernel
// applied in a single pass as a 2D cross with 13 taps along each axis.
// Actual kernel: 5-tap with weights [0.0625, 0.25, 0.375, 0.25, 0.0625]
const kWeights: array<f32, 5> = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outDims = vec2<i32>(textureDimensions(outputBlurred));
    let coord   = vec2<i32>(gid.xy);
    if (coord.x >= outDims.x || coord.y >= outDims.y) { return; }

    let uv      = (vec2<f32>(coord) + 0.5) / vec2<f32>(outDims);

    // Sample GBuffer for bilateral weights at the centre pixel
    let centreNormal = textureSampleLevel(gNormals,     samplerPoint, uv, 0.0);
    let centreDepth  = textureSampleLevel(gLinearDepth, samplerPoint, uv, 0.0).r;

    // Roughness is stored in gNormals.b
    let roughness = centreNormal.b;

    // Skip fully sharp mirrors and sky pixels — no blur needed
    let rawCenter = textureSampleLevel(ssrRaw, samplerLinear, uv, 0.0);
    if (roughness < 0.05 || centreDepth > 0.999) {
        textureStore(outputBlurred, coord, rawCenter);
        return;
    }

    // Roughness-adaptive radius: 0 px at roughness=0, 4 px at roughness=0.6+
    let maxRadius = 4.0;
    let radius    = roughness / 0.6 * maxRadius;
    let iRadius   = max(i32(ceil(radius)), 1);

    let texelSize = 1.0 / vec2<f32>(outDims);

    var accum  = vec4<f32>(0.0);
    var totalW = 0.0;

    // Separable 2D Gaussian via two orthogonal 1D passes in one compute call.
    // We do a true 2D kernel but limit to ±iRadius to keep sample count bounded.
    for (var dy: i32 = -iRadius; dy <= iRadius; dy++) {
        for (var dx: i32 = -iRadius; dx <= iRadius; dx++) {
            let sampleCoord = coord + vec2<i32>(dx, dy);
            if (sampleCoord.x < 0 || sampleCoord.x >= outDims.x ||
                sampleCoord.y < 0 || sampleCoord.y >= outDims.y) { continue; }

            let sUV = (vec2<f32>(sampleCoord) + 0.5) / vec2<f32>(outDims);

            // Bilateral depth weight: reject samples from different surfaces
            let sDepth = textureSampleLevel(gLinearDepth, samplerPoint, sUV, 0.0).r;
            let depthDiff = abs(sDepth - centreDepth);
            let depthW = exp(-depthDiff * 60.0);

            // Spatial Gaussian weight (isotropic, sigma = radius * 0.5)
            let sigma2    = max(radius * radius * 0.25, 0.001);
            let distSq    = f32(dx * dx + dy * dy);
            let spatialW  = exp(-distSq / (2.0 * sigma2));

            let w = spatialW * depthW;

            let sample = textureSampleLevel(ssrRaw, samplerLinear, sUV, 0.0);
            accum  += sample * w;
            totalW += w;
        }
    }

    let result = select(rawCenter, accum / totalW, totalW > 0.0001);
    textureStore(outputBlurred, coord, result);
}
