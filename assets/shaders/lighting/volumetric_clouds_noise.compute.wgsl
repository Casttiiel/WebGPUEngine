// ── Volumetric cloud noise baking ──────────────────────────────────────────────
//
// Run once at load.  Bakes all the procedural noise that the cloud ray-march used
// to evaluate per sample into three TILEABLE textures (sampled with 'repeat'):
//
//   shapeTex   128³ rgba8  — R: Perlin fBm (4 oct)          G: inverted Worley fBm (low)
//                             B: inverted Worley fBm (mid)   A: inverted Worley fBm (high)
//   detailTex   32³ rgba8  — RGB: inverted Worley fBm at 3 frequencies (edge erosion)
//   weatherTex 512² rgba8  — R: regional coverage fBm       G: per-column top-height noise
//
// Tiling: every lattice (Perlin and Worley) wraps at an integer period, so the
// texture edges match and the GPU can repeat them seamlessly.  The clouds still
// move: the ray-march offsets the sample coordinates by wind/time.

@group(0) @binding(0) var shapeOut:   texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detailOut:  texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(2) var weatherOut: texture_storage_2d<rgba8unorm, write>;

// ── Hashing (PCG3D — integer hash, no fract() precision artefacts) ────────────

fn pcg3d(v_in: vec3u) -> vec3u {
    var v = v_in * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}

fn hash3(cell: vec3i, period: i32, seed: u32) -> vec3f {
    // Wrap the lattice coordinate → tileable noise
    let c = vec3u(((cell % period) + period) % period);
    return vec3f(pcg3d(c + vec3u(seed, seed * 7u, seed * 13u))) * (1.0 / 4294967295.0);
}

// ── Tileable gradient (Perlin) noise ──────────────────────────────────────────

fn gradDot(cell: vec3i, f: vec3f, period: i32, seed: u32) -> f32 {
    let g = normalize(hash3(cell, period, seed) * 2.0 - 1.0 + vec3f(1e-5));
    return dot(g, f);
}

fn perlin3(p: vec3f, period: i32, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic fade
    let n000 = gradDot(i + vec3i(0, 0, 0), f - vec3f(0, 0, 0), period, seed);
    let n100 = gradDot(i + vec3i(1, 0, 0), f - vec3f(1, 0, 0), period, seed);
    let n010 = gradDot(i + vec3i(0, 1, 0), f - vec3f(0, 1, 0), period, seed);
    let n110 = gradDot(i + vec3i(1, 1, 0), f - vec3f(1, 1, 0), period, seed);
    let n001 = gradDot(i + vec3i(0, 0, 1), f - vec3f(0, 0, 1), period, seed);
    let n101 = gradDot(i + vec3i(1, 0, 1), f - vec3f(1, 0, 1), period, seed);
    let n011 = gradDot(i + vec3i(0, 1, 1), f - vec3f(0, 1, 1), period, seed);
    let n111 = gradDot(i + vec3i(1, 1, 1), f - vec3f(1, 1, 1), period, seed);
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z); // ≈ [-1, 1]
}

// uvw ∈ [0,1)³ — base octave has `period` cells across the texture.
fn perlinFbm(uvw: vec3f, period: i32, octaves: i32, seed: u32) -> f32 {
    var v = 0.0; var amp = 0.5; var norm = 0.0; var per = period;
    for (var o = 0; o < octaves; o++) {
        v    += amp * perlin3(uvw * f32(per), per, seed + u32(o) * 101u);
        norm += amp;
        amp  *= 0.5;
        per  *= 2;
    }
    return saturate((v / norm) * 0.5 + 0.5); // [0, 1], centred on 0.5
}

// ── Tileable Worley (cellular) noise ──────────────────────────────────────────

fn worley3(p: vec3f, period: i32, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = fract(p);
    var minD = 1e9;
    for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let o = vec3i(x, y, z);
                let r = hash3(i + o, period, seed);
                let d = vec3f(o) + r - f;
                minD = min(minD, dot(d, d));
            }
        }
    }
    return saturate(sqrt(minD)); // 0 at feature points
}

// Inverted Worley fBm (1 at cell centres → billowy puffs), 3 octaves.
fn worleyFbm(uvw: vec3f, period: i32, seed: u32) -> f32 {
    let w0 = worley3(uvw * f32(period),     period,     seed);
    let w1 = worley3(uvw * f32(period * 2), period * 2, seed + 31u);
    let w2 = worley3(uvw * f32(period * 4), period * 4, seed + 67u);
    return 1.0 - (w0 * 0.625 + w1 * 0.25 + w2 * 0.125);
}

// ── Entry points ──────────────────────────────────────────────────────────────

@compute @workgroup_size(4, 4, 4)
fn bakeShape(@builtin(global_invocation_id) gid: vec3u) {
    let size = textureDimensions(shapeOut);
    if (any(gid >= size)) { return; }
    let uvw = (vec3f(gid) + 0.5) / vec3f(size);

    let perlin = perlinFbm(uvw, 4, 4, 1u);
    let wLow   = worleyFbm(uvw, 4, 11u);
    let wMid   = worleyFbm(uvw, 8, 23u);
    let wHigh  = worleyFbm(uvw, 16, 37u);
    textureStore(shapeOut, gid, vec4f(perlin, wLow, wMid, wHigh));
}

@compute @workgroup_size(4, 4, 4)
fn bakeDetail(@builtin(global_invocation_id) gid: vec3u) {
    let size = textureDimensions(detailOut);
    if (any(gid >= size)) { return; }
    let uvw = (vec3f(gid) + 0.5) / vec3f(size);

    let w0 = worleyFbm(uvw, 2, 101u);
    let w1 = worleyFbm(uvw, 4, 131u);
    let w2 = worleyFbm(uvw, 8, 157u);
    textureStore(detailOut, gid, vec4f(w0, w1, w2, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn bakeWeather(@builtin(global_invocation_id) gid: vec3u) {
    let size = textureDimensions(weatherOut);
    if (any(gid.xy >= size)) { return; }
    let uv  = (vec2f(gid.xy) + 0.5) / vec2f(size);
    // z off the lattice planes (gradient noise is 0 on them); wraps at any period.
    let uvw = vec3f(uv, 0.37);

    // R: regional coverage — 2 octaves, 4 cells across the tile.
    // G: per-column cloud-top noise at 3× that frequency (12 cells) — matches the
    //    old shader where topNoise ran at 1.5× and cloudMap at 0.5× the base freq.
    let coverage = perlinFbm(uvw, 4, 2, 211u);
    let topNoise = perlinFbm(uvw, 12, 1, 223u);
    textureStore(weatherOut, gid.xy, vec4f(coverage, topNoise, 0.0, 1.0));
}
