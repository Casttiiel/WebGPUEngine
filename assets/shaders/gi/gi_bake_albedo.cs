// ---------------------------------------------------------------------------
// GI scene bake: albedo + emissive per triangle (GIScene.bakeMaterials).
// One texture tap at the triangle's UV centroid, from the mip whose texel covers the
// triangle's UV footprint, so a hit reads the surface's average colour with no texture
// binding at trace time. Same inputs as gbuffer.fs: albedo × baseColorFactor and
// emissive texture.x × emissiveFactor (selfIllum = albedo × emissive).
// ---------------------------------------------------------------------------

struct BakeParams {
    triOffset:      u32,
    triCount:       u32,
    emissiveFactor: f32,
    _pad:           f32,
    baseColor:      vec4<f32>,
}

@group(0) @binding(0) var txAlbedo:   texture_2d<f32>;
@group(0) @binding(1) var txEmissive: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
// u, v, lod, destination triangle (u32 bits): the merged static BLAS interleaves materials.
@group(0) @binding(3) var<storage, read> uvLod: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> tris: array<u32>;    // GITriangle, 12 words each
@group(0) @binding(5) var<uniform> params: BakeParams;

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.triCount) { return; }
    let s = uvLod[i];
    let albedo = textureSampleLevel(txAlbedo, texSampler, s.xy, s.z).rgb * params.baseColor.rgb;
    let emissive = textureSampleLevel(txEmissive, texSampler, s.xy, s.z).x * params.emissiveFactor;
    let o = bitcast<u32>(s.w) * 12u;
    tris[o + 3u] = pack4x8unorm(vec4<f32>(saturate(albedo), 1.0));
    tris[o + 7u] = bitcast<u32>(emissive);
}
