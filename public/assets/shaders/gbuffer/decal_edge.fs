#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

// ─── Edge decal (decal pass, partial G-buffer) ───────────────────────────────
//
// Drawn on the strips EdgeDecalComponent lays along a box's edges. Edits what the object
// already wrote to the G-buffer, so it works over any surface material:
//   • bevel: bends the normal toward the other face of the edge (rounded fillet profile),
//     so the edge catches light instead of being a razor-sharp line
//   • wear: an irregular band along the edge with its own tint, roughness and metalness
//     (lighter raw wood, chipped paint, bare metal…)
//
// Strip vertex data: N = face the strip lies on, T.xyz = other face of the edge,
// Uv = (distance to the edge, position along it) in metres.
//
// MaterialFactors, reused (see edge_wear_*.mat):
//   baseColorFactor.rgb  wear tint (multiplies the albedo; > 1 lightens)
//   baseColorFactor.a    wear opacity
//   roughnessFactor      roughness of the worn band
//   metallicFactor       metalness of the worn band
//   uvXScale             wear band width (m)
//   uvYScale             wear noise frequency (cycles per m)
//   surfaceBlend         bevel radius (m)
//   appearanceBlend      bevel strength (0–1)

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@group(3) @binding(0) var gBufferAlbedo:  texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth:   texture_2d<f32>;

struct DecalEdgeOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
}

fn hash21(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2<f32>) -> f32 {
    return valueNoise(p) * 0.55 + valueNoise(p * 2.13 + 17.0) * 0.3 + valueNoise(p * 4.37 + 41.0) * 0.15;
}

@fragment
fn fs(input: VertexOutput) -> DecalEdgeOutput {
    let across = input.Uv.x;
    let along  = input.Uv.y;
    let acrossFw = fwidth(across);

    // Only on the surface the strip was built for: where the object discarded the pixel
    // (silhouette POM) or the G-buffer holds something else, leave it alone.
    let coord      = vec2<i32>(input.position.xy);
    let sceneDepth = textureLoad(gLinearDepth, coord, 0).r * camera.cameraFar;
    let ownDepth   = dot(input.WorldPos - camera.cameraPosition.xyz, camera.cameraFront.xyz);
    if (abs(sceneDepth - ownDepth) > 0.02 + 0.002 * ownDepth) {
        discard;
    }

    let origAlbedo = textureLoad(gBufferAlbedo, coord, 0);
    let origNormal = textureLoad(gBufferNormals, coord, 0);

    // ── Wear band with a noisy inner border ──────────────────────────────────
    let freq   = factors.uvYScale;
    let n      = fbm(vec2<f32>(along * freq, across * freq * 1.7));
    let border = factors.uvXScale * mix(0.1, 1.0, n * n * (3.0 - 2.0 * n));
    let wear   = (1.0 - smoothstep(border - acrossFw, border + acrossFw, across))
               * factors.baseColorFactor.a;

    // ── Bevel: fillet of radius r between this face (nA) and the other (nB) ──
    // On this face's half of the arc the normal tilts by asin(1 − x/r), at most 45°
    // (the bisector, reached where the other face's strip takes over).
    let nA = normalize(input.N);
    let nB = normalize(input.T.xyz);
    let r  = max(factors.surfaceBlend, 1e-4);
    // Fades out once the fillet is narrower than ~2 pixels: it would only alias.
    let bevelStrength = factors.appearanceBlend * saturate(r / max(2.0 * acrossFw, 1e-5) - 0.5);
    let theta = min(asin(saturate(1.0 - across / r)), 0.78539816) * bevelStrength;
    let bevelN = nA * cos(theta) + nB * sin(theta);

    let origN = octahedral01ToNormal(origNormal.xy);
    let N     = normalize(origN + (bevelN - nA));

    var out: DecalEdgeOutput;
    out.albedo = vec4<f32>(mix(origAlbedo.rgb, origAlbedo.rgb * factors.baseColorFactor.rgb, wear),
                           mix(origAlbedo.a, factors.metallicFactor, wear));
    out.normal = vec4<f32>(normalToOctahedral01(N),
                           mix(origNormal.z, factors.roughnessFactor, wear),
                           origNormal.w);
    return out;
}
