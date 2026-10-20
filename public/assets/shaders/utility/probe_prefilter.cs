// ─── Reflection probe prefilter (compute) ────────────────────────────────────
//
// downsample: 2×2 box reduction of one mip of the captured cube into the next, so the
//             GGX pass can read a blurred source (filtered importance sampling).
// prefilter:  GGX-convolves the captured cube into one mip of the probe's slot in the
//             cube array (Karis 2013, split-sum, N = V = R). Mip m holds roughness
//             m / (mips − 1), the same linear mapping ambient_specular.fs samples with.
//
// Face texel → direction uses WebGPU's cube convention (as SHProjector.faceDir).

#include "common/ibl/sampling"

struct PrefilterParams {
    dstSize:     u32,
    srcSize:     u32,
    sampleCount: u32,
    _pad:        u32,
    roughness:   f32,
    _pad1:       f32,
    _pad2:       f32,
    _pad3:       f32,
}

// ── downsample ──
@group(1) @binding(0) var dsSrc: texture_2d_array<f32>;
@group(1) @binding(1) var dsDst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(dsDst);
    if (gid.x >= size.x || gid.y >= size.y) { return; }
    let p = vec2<i32>(gid.xy) * 2;
    let f = i32(gid.z);
    let c = textureLoad(dsSrc, p, f, 0) + textureLoad(dsSrc, p + vec2<i32>(1, 0), f, 0)
          + textureLoad(dsSrc, p + vec2<i32>(0, 1), f, 0) + textureLoad(dsSrc, p + vec2<i32>(1, 1), f, 0);
    textureStore(dsDst, vec2<i32>(gid.xy), f, c * 0.25);
}

// ── prefilter ──
@group(0) @binding(0) var pfSrc: texture_cube<f32>;
@group(0) @binding(1) var pfSampler: sampler;
@group(0) @binding(2) var pfDst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: PrefilterParams;

fn cubeDir(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let sc = uv.x * 2.0 - 1.0;
    let tc = uv.y * 2.0 - 1.0;
    var d: vec3<f32>;
    switch (face) {
        case 0u: { d = vec3<f32>( 1.0, -tc, -sc); }
        case 1u: { d = vec3<f32>(-1.0, -tc,  sc); }
        case 2u: { d = vec3<f32>( sc,  1.0,  tc); }
        case 3u: { d = vec3<f32>( sc, -1.0, -tc); }
        case 4u: { d = vec3<f32>( sc, -tc,  1.0); }
        default: { d = vec3<f32>(-sc, -tc, -1.0); }
    }
    return normalize(d);
}

@compute @workgroup_size(8, 8, 1)
fn prefilter(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.dstSize || gid.y >= params.dstSize) { return; }
    let uv = (vec2<f32>(gid.xy) + 0.5) / f32(params.dstSize);
    let N = cubeDir(gid.z, uv);

    let roughness = params.roughness;
    if (roughness < 0.01) {
        textureStore(pfDst, vec2<i32>(gid.xy), i32(gid.z), textureSampleLevel(pfSrc, pfSampler, N, 0.0));
        return;
    }

    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let T  = normalize(cross(up, N));
    let B  = cross(N, T);
    let a  = roughness * roughness;
    let a2 = a * a;
    // Solid angle of one source texel (mip 0).
    let texelSA = 4.0 * PI / (6.0 * f32(params.srcSize * params.srcSize));

    var color  = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < params.sampleCount; i++) {
        let xi = hammersley(i, params.sampleCount);
        let h  = importanceSampleGGX(xi, roughness);
        let H  = normalize(T * h.x + B * h.y + N * h.z);
        let L  = normalize(2.0 * dot(N, H) * H - N);
        let NdotL = dot(N, L);
        if (NdotL <= 0.0) { continue; }
        // pdf of L (N = V): D · NdotH / (4 · VdotH) = D / 4.
        let NdotH = max(dot(N, H), 0.0);
        let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
        let D  = a2 / (PI * d * d);
        let pdf = D * 0.25 + 1e-4;
        let sampleSA = 1.0 / (f32(params.sampleCount) * pdf);
        let lod = max(0.5 * log2(sampleSA / texelSA) + 1.0, 0.0);
        color  += textureSampleLevel(pfSrc, pfSampler, L, lod).rgb * NdotL;
        weight += NdotL;
    }
    textureStore(pfDst, vec2<i32>(gid.xy), i32(gid.z), vec4<f32>(color / max(weight, 1e-4), 1.0));
}
