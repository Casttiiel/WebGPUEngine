// ---------------------------------------------------------------------------
// GI skinned BLAS, step 1 (GISkinnedBLAS.ts): one thread per skinned triangle. Linear blend
// skinning of its three bind-pose vertices with the character's joint palette (copied this
// frame from SkeletalMeshComponent, same matrices as gbuffer_skinned.vs → model space), written
// as v0 / e1 / e2 into the scene's triangle buffer. Only xyz: the albedo / emissive / flag words
// (.w) keep what GIScene baked. gi_refit.cs then fixes the node bounds.
// ---------------------------------------------------------------------------

struct SkinParams {
    info: vec4<u32>,   // x = first skinned triangle (absolute), y = skinned triangle count
}

// Per vertex: (bind-pose position xyz, joints packed 4 × u8 in w bits), (weights).
@group(0) @binding(0) var<storage, read> skinVertices: array<vec4<f32>>;
// Per triangle: (vertex a, b, c, palette base) — vertex indices into skinVertices / 2.
@group(0) @binding(1) var<storage, read> skinTriangles: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> palettes: array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read_write> bvhTris: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> params: SkinParams;

fn skinned(v: u32, paletteBase: u32) -> vec3<f32> {
    let a = skinVertices[v * 2u];
    let w = skinVertices[v * 2u + 1u];
    let j = bitcast<u32>(a.w);
    let m = w.x * palettes[paletteBase + (j & 0xffu)]
          + w.y * palettes[paletteBase + ((j >> 8u) & 0xffu)]
          + w.z * palettes[paletteBase + ((j >> 16u) & 0xffu)]
          + w.w * palettes[paletteBase + (j >> 24u)];
    return (m * vec4<f32>(a.xyz, 1.0)).xyz;
}

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.info.y) { return; }
    let r = skinTriangles[gid.x];
    let p0 = skinned(r.x, r.w);
    let p1 = skinned(r.y, r.w);
    let p2 = skinned(r.z, r.w);
    let t = (params.info.x + gid.x) * 3u;
    bvhTris[t] = vec4<f32>(p0, bvhTris[t].w);
    bvhTris[t + 1u] = vec4<f32>(p1 - p0, bvhTris[t + 1u].w);
    bvhTris[t + 2u] = vec4<f32>(p2 - p0, bvhTris[t + 2u].w);
}
