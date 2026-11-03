// ─── God Rays Composite ───────────────────────────────────────────────────────
//
// Final step of the volumetric god rays pipeline.
//
// Joint-bilateral upsample of the half-res shaft buffer to full resolution:
// a 4×4 neighbourhood of low-res texels is weighted by spatial distance and by
// depth similarity against the full-res GBuffer depth, so shafts don't bleed
// over the silhouettes of nearby geometry.
//
// The pipeline uses ADDITIVE blending (ONE + ONE), so this shader only outputs
// the contribution to add:
//   output.rgb = sunColor × shafts × scale × exposure
//
// Bind-group layout
//   group(0)  GBufferUniforms            (linearDepth, binding 2)
//   group(1)  Blurred shafts + sampler   (SingleTexture — r = scatter, g = depth)
//   group(2)  GodRaysCompositeParams     (GodRaysUniforms)
//   group(3)  AutoExposureRead — adapted scene exposure f32 (read-only storage)

// 4 × f32 = 16 bytes.
struct GodRaysCompositeParams {
    sunR:  f32,
    sunG:  f32,
    sunB:  f32,
    scale: f32,  // intensity × compositeScale (0 = disabled)
}

@group(0) @binding(2) var gLinearDepth: texture_2d<f32>;

@group(1) @binding(0) var shaftsTexture: texture_2d<f32>;
@group(1) @binding(1) var shaftsSampler: sampler;

@group(2) @binding(0) var<uniform> params: GodRaysCompositeParams;

@group(3) @binding(0) var<storage, read> exposureData: array<f32>;

const SPATIAL_SIGMA: f32 = 1.0;
const DEPTH_SIGMA: f32 = 0.05;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (params.scale <= 0.0) {
        return vec4<f32>(0.0);
    }

    let depthDims = vec2<i32>(textureDimensions(gLinearDepth));
    let depthCoord = clamp(vec2<i32>(uv * vec2<f32>(depthDims)), vec2<i32>(0), depthDims - 1);
    let depth = textureLoad(gLinearDepth, depthCoord, 0).r;

    // Position of this pixel in low-res texel space (texel centres at integer + 0.5).
    let lowDims = vec2<i32>(textureDimensions(shaftsTexture));
    let texelPos = uv * vec2<f32>(lowDims) - 0.5;
    let base = vec2<i32>(floor(texelPos));
    let f = texelPos - floor(texelPos);

    let invSpatial = 1.0 / (2.0 * SPATIAL_SIGMA * SPATIAL_SIGMA);
    let invDepth = 1.0 / (2.0 * DEPTH_SIGMA * DEPTH_SIGMA);

    var sum = 0.0;
    var wSum = 0.0;
    for (var y = -1; y <= 2; y++) {
        for (var x = -1; x <= 2; x++) {
            let p = clamp(base + vec2<i32>(x, y), vec2<i32>(0), lowDims - 1);
            let s = textureLoad(shaftsTexture, p, 0);
            let d = vec2<f32>(f32(x), f32(y)) - f;
            let spatialW = exp(-dot(d, d) * invSpatial);
            let dz = (s.g - depth) / max(depth, 1e-4);
            // Small spatial floor: if every tap is depth-rejected (thin geometry
            // under-sampled at half-res) we degrade to a plain spatial filter.
            let w = spatialW * (exp(-dz * dz * invDepth) + 1e-4);
            sum += s.r * w;
            wSum += w;
        }
    }
    let shafts = sum / max(wSum, 1e-6);

    let contribution = vec3<f32>(params.sunR, params.sunG, params.sunB) * shafts * params.scale * exposureData[0];
    return vec4<f32>(contribution, 0.0);
}
