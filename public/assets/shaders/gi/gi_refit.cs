// ---------------------------------------------------------------------------
// GI skinned BLAS, step 2 (GISkinnedBLAS.ts): refit of the skinned BLAS after gi_skin.cs. One
// dispatch per tree depth, deepest first, over the nodes of that depth of every skinned BLAS
// (refitNodes, absolute node indices; level = this dispatch's slice). A leaf takes the bounds of
// its triangles, an internal node the union of its two children (one level deeper: already
// refitted). Node layout as gi/common/bvh.wgsl; the index / count words (.w) are untouched.
// ---------------------------------------------------------------------------

struct RefitLevel {
    range: vec4<u32>,   // x = first entry in refitNodes, y = nodes at this depth
}

@group(0) @binding(0) var<storage, read_write> bvhNodes: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> bvhTris: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> refitNodes: array<u32>;
@group(1) @binding(0) var<uniform> level: RefitLevel;

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= level.range.y) { return; }
    let n = refitNodes[level.range.x + gid.x];
    let a = bvhNodes[n * 2u];
    let b = bvhNodes[n * 2u + 1u];
    let first = bitcast<u32>(a.w);
    let count = bitcast<u32>(b.w);

    var lo = vec3<f32>(1.0e30);
    var hi = vec3<f32>(-1.0e30);
    if (count > 0u) {
        for (var i = first; i < first + count; i++) {
            let v0 = bvhTris[i * 3u].xyz;
            let v1 = v0 + bvhTris[i * 3u + 1u].xyz;
            let v2 = v0 + bvhTris[i * 3u + 2u].xyz;
            lo = min(lo, min(v0, min(v1, v2)));
            hi = max(hi, max(v0, max(v1, v2)));
        }
    } else {
        lo = min(bvhNodes[first * 2u].xyz, bvhNodes[(first + 1u) * 2u].xyz);
        hi = max(bvhNodes[first * 2u + 1u].xyz, bvhNodes[(first + 1u) * 2u + 1u].xyz);
    }
    bvhNodes[n * 2u] = vec4<f32>(lo, a.w);
    bvhNodes[n * 2u + 1u] = vec4<f32>(hi, b.w);
}
