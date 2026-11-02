// ─── Software ray tracing over the GI scene (GIScene.ts) ──────────────────────
//
// Two-level BVH2 in one node array: the TLAS (nodes 0..) over instances, then every BLAS in
// object space. Node = 2 × vec4: (min.xyz, leftFirst) (max.xyz, count); count == 0 → internal
// with children leftFirst and leftFirst + 1, otherwise a leaf. TLAS leaves hold one instance;
// BLAS leaves hold `count` triangles from leftFirst (absolute indices).
//
// Triangle = 3 × vec4: (v0.xyz, albedo rgba8) (e1.xyz, emissive) (e2.xyz, flags), object space;
// flags bit 0 = winding opposite to the vertex normals (GIScene).
// Instance = 4 × vec4: rows 0–2 of inverse(world), then (blasRoot, -, -, -).
//
// Rays are transformed into object space without renormalising, so `t` stays a world-space
// distance across instances.

@group(1) @binding(0) var<storage, read> bvhNodes:     array<vec4<f32>>;
@group(1) @binding(1) var<storage, read> bvhTris:      array<vec4<f32>>;
@group(1) @binding(2) var<storage, read> bvhInstances: array<vec4<f32>>;

const GI_MISS: u32 = 0xffffffffu;
const GI_STACK_SIZE: u32 = 40u;
const GI_NO_HIT: f32 = 1.0e30;

struct GIHit {
    t:        f32,
    tri:      u32,   // GI_MISS when nothing was hit
    instance: u32,
    u:        f32,
    v:        f32,
}

struct GISurface {
    pos:       vec3<f32>,
    normal:    vec3<f32>,   // world space, facing the ray origin
    albedo:    vec3<f32>,
    emissive:  f32,
    frontFace: bool,        // false when the ray hit the triangle's back side
}

fn giSafeInverse(d: vec3<f32>) -> vec3<f32> {
    let eps = vec3<f32>(1e-9);
    return 1.0 / select(d, eps * select(vec3<f32>(-1.0), vec3<f32>(1.0), d >= vec3<f32>(0.0)), abs(d) < eps);
}

/** Entry distance into the box, or GI_NO_HIT when the ray misses it before tMax. */
fn giRayBox(o: vec3<f32>, invD: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>, tMax: f32) -> f32 {
    let t0 = (bmin - o) * invD;
    let t1 = (bmax - o) * invD;
    let lo = min(t0, t1);
    let hi = max(t0, t1);
    let tNear = max(max(lo.x, lo.y), max(lo.z, 0.0));
    let tFar = min(min(hi.x, hi.y), min(hi.z, tMax));
    return select(GI_NO_HIT, tNear, tNear <= tFar);
}

/** Möller–Trumbore, both faces. Returns (t, u, v); t < 0 on a miss. */
fn giRayTriangle(o: vec3<f32>, d: vec3<f32>, v0: vec3<f32>, e1: vec3<f32>, e2: vec3<f32>, tMax: f32) -> vec3<f32> {
    let p = cross(d, e2);
    let det = dot(e1, p);
    if (abs(det) < 1e-12) { return vec3<f32>(-1.0); }
    let inv = 1.0 / det;
    let s = o - v0;
    let u = dot(s, p) * inv;
    if (u < 0.0 || u > 1.0) { return vec3<f32>(-1.0); }
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    if (v < 0.0 || u + v > 1.0) { return vec3<f32>(-1.0); }
    let t = dot(e2, q) * inv;
    if (t <= 1e-4 || t >= tMax) { return vec3<f32>(-1.0); }
    return vec3<f32>(t, u, v);
}

/**
 * Closest hit along origin + dir·t, t in (0, tMax). `anyHit` returns on the first triangle
 * hit (shadow / visibility rays).
 */
fn giTrace(origin: vec3<f32>, dir: vec3<f32>, tMax: f32, anyHit: bool) -> GIHit {
    var hit: GIHit;
    hit.t = tMax;
    hit.tri = GI_MISS;
    hit.instance = GI_MISS;

    var stack: array<u32, GI_STACK_SIZE>;
    var sp = 0u;
    var o = origin;
    var d = dir;
    var invD = giSafeInverse(dir);
    var node = 0u;
    var inBlas = false;
    var blasBase = 0u;
    var instance = 0u;

    loop {
        let a = bvhNodes[node * 2u];
        let b = bvhNodes[node * 2u + 1u];
        let first = bitcast<u32>(a.w);
        let count = bitcast<u32>(b.w);

        if (count == 0u) {
            // Internal: visit the nearer child, keep the farther one for later.
            let l = first;
            let r = first + 1u;
            let tl = giRayBox(o, invD, bvhNodes[l * 2u].xyz, bvhNodes[l * 2u + 1u].xyz, hit.t);
            let tr = giRayBox(o, invD, bvhNodes[r * 2u].xyz, bvhNodes[r * 2u + 1u].xyz, hit.t);
            let hl = tl < GI_NO_HIT;
            let hr = tr < GI_NO_HIT;
            if (hl && hr) {
                let nearFirst = tl <= tr;
                if (sp < GI_STACK_SIZE) {
                    stack[sp] = select(l, r, nearFirst);
                    sp += 1u;
                }
                node = select(r, l, nearFirst);
                continue;
            }
            if (hl) { node = l; continue; }
            if (hr) { node = r; continue; }
        } else if (!inBlas) {
            // TLAS leaf: enter the instance's BLAS with the ray in object space.
            instance = first;
            let r0 = bvhInstances[instance * 4u];
            let r1 = bvhInstances[instance * 4u + 1u];
            let r2 = bvhInstances[instance * 4u + 2u];
            o = vec3<f32>(dot(r0.xyz, origin) + r0.w, dot(r1.xyz, origin) + r1.w, dot(r2.xyz, origin) + r2.w);
            d = vec3<f32>(dot(r0.xyz, dir), dot(r1.xyz, dir), dot(r2.xyz, dir));
            invD = giSafeInverse(d);
            inBlas = true;
            blasBase = sp;
            node = bitcast<u32>(bvhInstances[instance * 4u + 3u].x);
            continue;
        } else {
            for (var i = first; i < first + count; i++) {
                let t0 = bvhTris[i * 3u];
                let t1 = bvhTris[i * 3u + 1u];
                let t2 = bvhTris[i * 3u + 2u];
                let h = giRayTriangle(o, d, t0.xyz, t1.xyz, t2.xyz, hit.t);
                if (h.x > 0.0) {
                    hit.t = h.x;
                    hit.u = h.y;
                    hit.v = h.z;
                    hit.tri = i;
                    hit.instance = instance;
                    if (anyHit) { return hit; }
                }
            }
        }

        // Pop. Leaving a BLAS (stack back to where it was entered) restores the world ray.
        if (inBlas && sp == blasBase) {
            inBlas = false;
            o = origin;
            d = dir;
            invD = giSafeInverse(dir);
        }
        if (sp == 0u) { break; }
        sp -= 1u;
        node = stack[sp];
    }
    return hit;
}

/** Surface attributes at a hit returned by giTrace. */
fn giHitSurface(origin: vec3<f32>, dir: vec3<f32>, hit: GIHit) -> GISurface {
    let t0 = bvhTris[hit.tri * 3u];
    let t1 = bvhTris[hit.tri * 3u + 1u];
    let t2 = bvhTris[hit.tri * 3u + 2u];
    // flags bit 0: winding opposite to the vertex normals → the front is the other side.
    let flip = select(1.0, -1.0, (bitcast<u32>(t2.w) & 1u) != 0u);
    let nObj = cross(t1.xyz, t2.xyz) * flip;
    // Normal to world: transpose(inverse(world)) · n = Σ n_i · row_i.
    let r0 = bvhInstances[hit.instance * 4u].xyz;
    let r1 = bvhInstances[hit.instance * 4u + 1u].xyz;
    let r2 = bvhInstances[hit.instance * 4u + 2u].xyz;
    let nWorld = normalize(r0 * nObj.x + r1 * nObj.y + r2 * nObj.z);

    var s: GISurface;
    s.pos = origin + dir * hit.t;
    s.frontFace = dot(nWorld, dir) < 0.0;
    s.normal = select(-nWorld, nWorld, s.frontFace);
    s.albedo = unpack4x8unorm(bitcast<u32>(t0.w)).rgb;
    s.emissive = t1.w;
    return s;
}
