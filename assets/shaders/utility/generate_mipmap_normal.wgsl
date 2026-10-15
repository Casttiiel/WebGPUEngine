// Normal-map aware mipmap generator.
// A standard box-filter averages the raw [0,1]-encoded channel values, which
// does NOT preserve the direction of the stored normal vectors.  This shader
// instead:
//   1. Decodes  [0,1] -> [-1,1] for all three components
//   2. Averages the four source normals in real normal-space
//   3. Normalises the result (eliminates the shimmering caused by shrinking length)
//   4. Re-encodes [-1,1] -> [0,1] for storage
//
// Use this instead of generate_mipmap.wgsl whenever the source texture is an
// RGB/RGBA tangent-space normal map.

@group(0) @binding(0) var inputTexture:  texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let outDims = textureDimensions(outputTexture);
    if (global_id.x >= outDims.x || global_id.y >= outDims.y) { return; }

    let coord   = vec2<i32>(global_id.xy);
    let inCoord = coord * 2;

    // Load four source texels (values still in [0,1] encoded space)
    let s00 = textureLoad(inputTexture, inCoord + vec2<i32>(0, 0), 0).rgb;
    let s10 = textureLoad(inputTexture, inCoord + vec2<i32>(1, 0), 0).rgb;
    let s01 = textureLoad(inputTexture, inCoord + vec2<i32>(0, 1), 0).rgb;
    let s11 = textureLoad(inputTexture, inCoord + vec2<i32>(1, 1), 0).rgb;

    // Decode [0,1] -> [-1,1] for each normal
    let n00 = s00 * 2.0 - 1.0;
    let n10 = s10 * 2.0 - 1.0;
    let n01 = s01 * 2.0 - 1.0;
    let n11 = s11 * 2.0 - 1.0;

    // Average then normalise — preserves direction, eliminates shimmer at distance
    var avg = (n00 + n10 + n01 + n11) * 0.25;
    let len = length(avg);
    if (len > 0.001) {
        avg = avg / len;
    } else {
        // Degenerate case: all normals cancel out — fall back to straight-up
        avg = vec3<f32>(0.0, 0.0, 1.0);
    }

    // Re-encode [-1,1] -> [0,1] and write (alpha kept at 1.0)
    let encoded = avg * 0.5 + 0.5;
    textureStore(outputTexture, coord, vec4<f32>(encoded, 1.0));
}
