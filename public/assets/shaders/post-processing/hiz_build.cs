// Hi-Z depth pyramid builder — one compute pass per mip level.
// Reads one level (srcTex, exposed as a single-mip view) and writes the next
// (dstTex at half resolution) using 2×2 min-pooling.
//
// Sky pixels have linearDepth = 0 (G-Buffer clear value, no geometry written).
// They are remapped to 1.0 (far plane) so empty sky doesn't create false
// "close-surface" entries that would block Hi-Z skips in the SSR ray march.
//
// Two pipelines share this shader:
//   L0 pipeline  — src layout sampleType:'float'              (gLinearDepth r16float)
//   L1+ pipeline — src layout sampleType:'unfilterable-float' (hizTex r32float mip k)
//
// Bind group layout (@group 0):
//   binding 0 : srcTex  texture_2d<f32>                       (single mip, read-only)
//   binding 1 : dstTex  texture_storage_2d<r32float, write>   (single mip, write-only)

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d<r32float, write>;

fn loadDepth(coord: vec2<i32>, dims: vec2<i32>) -> f32 {
    let c = clamp(coord, vec2<i32>(0), dims - vec2<i32>(1));
    let d = textureLoad(srcTex, c, 0).r;
    return select(1.0, d, d > 0.0001); // sky (d≈0) → far plane (1.0)
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dstDims = vec2<i32>(textureDimensions(dstTex));
    let dst     = vec2<i32>(gid.xy);
    if (dst.x >= dstDims.x || dst.y >= dstDims.y) { return; }

    let srcDims = vec2<i32>(textureDimensions(srcTex));
    let base    = dst * 2;

    let d00 = loadDepth(base + vec2<i32>(0, 0), srcDims);
    let d10 = loadDepth(base + vec2<i32>(1, 0), srcDims);
    let d01 = loadDepth(base + vec2<i32>(0, 1), srcDims);
    let d11 = loadDepth(base + vec2<i32>(1, 1), srcDims);

    textureStore(dstTex, dst, vec4<f32>(min(min(d00, d10), min(d01, d11)), 0.0, 0.0, 1.0));
}
