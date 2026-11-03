// ─── Realtime GI: irradiance lookup from the probe volumes ────────────────────
//
// Includers include gi/common/gi_common first and declare, besides its bindings:
//   var giIrradianceAtlas: texture_2d<f32>;  var giVisibilityAtlas: texture_2d<f32>;
//   var giSampler: sampler;   (linear, clamp)
//   var<storage, read> giVolumes: array<GIVolume>;
//   var<storage, read> giProbeState: array<vec4<f32>>;

// ─── Realtime GI: per-probe state helpers ─────────────────────────────────────
//
// Includers include gi/common/gi_common first and declare giVolumes (gi/common/gi_volumes) and
//   var<storage, read> giProbeState: array<vec4<f32>>;   (or read_write)

// ─── Realtime GI: probe-volume layout helpers ─────────────────────────────────
//
// Includers include gi/common/gi_common first and declare
//   var<storage, read> giVolumes: array<GIVolume>;

fn giPosMod(a: vec3<i32>, n: vec3<i32>) -> vec3<i32> {
    return ((a % n) + n) % n;
}

/** Global probe index of the probe at absolute grid coordinate `coord` of volume `v`. */
fn giProbeIndex(v: u32, coord: vec3<i32>) -> u32 {
    let d = giVolumes[v].dims;
    let s = vec3<u32>(giPosMod(coord, vec3<i32>(d.xyz)));
    return d.w + s.x + s.y * d.x + s.z * d.x * d.y;
}

/** Atlas tile of a global probe index (same in both atlases). */
fn giTile(index: u32) -> vec2<u32> {
    return vec2<u32>(index % giParams.gridInfo.x, index / giParams.gridInfo.x);
}

/** Absolute coordinate held by storage slot `slot` (0..probes in the volume) of volume `v`. */
fn giSlotCoord(v: u32, slot: u32) -> vec3<i32> {
    let d = giVolumes[v].dims;
    let s = vec3<i32>(vec3<u32>(slot % d.x, (slot / d.x) % d.y, slot / (d.x * d.y)));
    let origin = giVolumes[v].origin.xyz;
    return origin + giPosMod(s - origin, vec3<i32>(d.xyz));
}


/** True when the slot holds `coord` (not a wrapped-in, not-yet-updated probe). */
fn giProbeHolds(index: u32, coord: vec3<i32>) -> bool {
    return all(vec3<i32>(round(giProbeState[index * 2u + 1u].xyz)) == coord);
}


/** Probe-weighted irradiance of one volume: rgb = Σ E·w, w = Σ w. */
fn giSampleVolume(v: u32, pos: vec3<f32>, n: vec3<f32>, view: vec3<f32>) -> vec4<f32> {
    let spacing = giVolumes[v].spacing.x;
    let origin = giVolumes[v].origin.xyz;
    let biasedPos = pos + (n * giParams.tuning2.x + view * giParams.tuning2.y) * spacing;
    let local = biasedPos / spacing - vec3<f32>(origin);
    let base = vec3<i32>(floor(local));
    let alpha = local - floor(local);
    let irrOct = (giOctEncode(n) * 0.5 + 0.5) * f32(GI_IRR_RES);

    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0u; i < 8u; i++) {
        let off = vec3<i32>(i32(i & 1u), i32((i >> 1u) & 1u), i32((i >> 2u) & 1u));
        let coord = origin + base + off;
        let index = giProbeIndex(v, coord);
        let state = giProbeState[index * 2u];
        if (state.w > GI_INACTIVE_RATIO || !giProbeHolds(index, coord)) { continue; }

        let probePos = vec3<f32>(coord) * spacing + state.xyz;
        let tri = mix(1.0 - alpha, alpha, vec3<f32>(off));

        // Smooth backface: probes behind the surface weigh little but never zero.
        let toProbe = normalize(probePos - pos);
        let wrap = (dot(toProbe, n) + 1.0) * 0.5;
        var w = wrap * wrap + 0.2;

        // Chebyshev visibility against the probe's mean hit distance in this direction.
        let probeToPoint = biasedPos - probePos;
        let dist = length(probeToPoint);
        let dir = probeToPoint / max(dist, 1e-4);
        let tile = giTile(index);
        let visUV = (vec2<f32>(tile * (GI_VIS_RES + 2u) + 1u)
                   + (giOctEncode(dir) * 0.5 + 0.5) * f32(GI_VIS_RES)) / giParams.atlasSize.zw;
        let m = textureSampleLevel(giVisibilityAtlas, giSampler, visUV, 0.0).rg;
        if (dist > m.x) {
            let variance = abs(m.x * m.x - m.y);
            let d = dist - m.x;
            let cheb = variance / (variance + d * d);
            w *= max(0.05, cheb * cheb * cheb);
        }

        // Crush tiny weights so a leaking probe can't dominate when all others are rejected.
        w = max(w, 1e-6);
        if (w < 0.2) { w *= w * w * 25.0; }
        w *= tri.x * tri.y * tri.z;

        let irrUV = (vec2<f32>(tile * (GI_IRR_RES + 2u) + 1u) + irrOct) / giParams.atlasSize.xy;
        sum += textureSampleLevel(giIrradianceAtlas, giSampler, irrUV, 0.0).rgb * w;
        wsum += w;
    }
    return vec4<f32>(sum, wsum);
}

/**
 * Irradiance E at a surface from the probe volumes, in list order (finest first), each faded
 * out over `spacing.y` cells at its edges. rgb = E × coverage, a = coverage (0–1): the caller
 * fills the rest. `view` = unit vector from the surface toward the viewer (camera or probe).
 */
fn giSampleIrradiance(pos: vec3<f32>, n: vec3<f32>, view: vec3<f32>) -> vec4<f32> {
    var result = vec3<f32>(0.0);
    var coverage = 0.0;
    for (var v = 0u; v < giParams.gridInfo.y; v++) {
        let vol = giVolumes[v];
        let local = pos / vol.spacing.x - vec3<f32>(vol.origin.xyz);
        let edgeV = min(local, vec3<f32>(vol.dims.xyz) - 1.0 - local);
        let edge = min(edgeV.x, min(edgeV.y, edgeV.z));
        if (edge <= 0.0) { continue; }
        let s = giSampleVolume(v, pos, n, view);
        if (s.w <= 1e-5) { continue; }
        let blend = saturate(edge / max(vol.spacing.y, 1e-3)) * (1.0 - coverage);
        result += (s.rgb / s.w) * blend;
        coverage += blend;
        if (coverage >= 0.999) { break; }
    }
    return vec4<f32>(result, coverage);
}
