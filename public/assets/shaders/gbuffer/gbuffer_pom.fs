#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"
#include "gbuffer/pom_common"

// ─── Parallax Occlusion Mapping (G-buffer) ───────────────────────────────────
//
// Permutations (material "features"):
//   (none)      Mesh UVs + mesh TBN. pomScale = relief depth in UV units.
//   BOX         Axis-aligned box faces (unit cube × model matrix): texture coordinates
//               are the world position projected on the face axes × uvXScale (tiles per
//               metre, like triplanar_world, but following the box when it rotates).
//               pomScale = relief depth in metres.
//   SILHOUETTE  (needs BOX) a view ray that leaves the box before hitting the relief is
//               discarded, so the relief also cuts the object's outline. The technique
//               variant skips the depth prepass and writes depth itself (a prepass
//               without the discard would leave holes).
//   POM_SHADOW  Soft self-shadow toward the sun, marched in the height field. Deferred
//               lighting can't take it, so it darkens the albedo (pomShadow = strength).
//
// Height map: R, 1 = surface (the mesh), 0 = deepest. The relief is carved INTO the mesh,
// so the geometric depth written below is the top of the relief and nothing pokes out.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var txHeight:    texture_2d<f32>;
@group(1) @binding(6) var samplerState: sampler;
@group(1) @binding(7) var<uniform> factors: PomFactors;

const MIN_STEPS    = 6.0;
const MAX_STEPS    = 48.0;
const SHADOW_STEPS = 12;
// Steepest view the march extrapolates (cos ≈ 0.1 → 84°): beyond it the ray length explodes.
const MIN_VIEW_COS = 0.1;

// Texture-space frame of the shaded point.
struct Surface {
    uv:    vec2<f32>,  // base texture coordinates
    dirU:  vec3<f32>,  // world direction of +u
    dirV:  vec3<f32>,  // world direction of +v
    mapT:  vec3<f32>,  // world direction of the normal map's +X
    mapB:  vec3<f32>,  // world direction of the normal map's +Y
    N:     vec3<f32>,  // outward surface normal
    scale: f32,        // uv units per unit of pomScale (1 for mesh UVs, uvXScale for BOX)
    duvdx: vec2<f32>,
    duvdy: vec2<f32>,
}

fn meshSurface(input: POMVertexOutput) -> Surface {
    var s: Surface;
    let TBN = computeTBN(normalize(input.N), input.T);
    s.uv    = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    s.dirU  = TBN[0];
    s.dirV  = TBN[1];
    s.mapT  = TBN[0];
    s.mapB  = TBN[1];
    s.N     = TBN[2];
    s.scale = 1.0;
    return s;
}

fn boxSurface(input: POMVertexOutput) -> Surface {
    var s: Surface;
    let n = normalize(input.N);
    let l = vec3<f32>(dot(n, input.BoxAxisX), dot(n, input.BoxAxisY), dot(n, input.BoxAxisZ));
    let a = abs(l);
    // Face = dominant box axis of the normal. "up" is the image's up on that face.
    var N  = input.BoxAxisZ * sign(l.z);
    var up = input.BoxAxisY;
    if (a.y >= a.x && a.y >= a.z) {
        N  = input.BoxAxisY * sign(l.y);
        up = -input.BoxAxisZ * sign(l.y);
    } else if (a.x >= a.z) {
        N  = input.BoxAxisX * sign(l.x);
    }
    let T = cross(up, N); // image right, seen from outside
    s.scale = factors.uvXScale;
    s.uv    = vec2<f32>(dot(input.WorldPos, T), -dot(input.WorldPos, up)) * s.scale;
    s.dirU  = T;
    s.dirV  = -up;
    s.mapT  = T;
    s.mapB  = up;   // *_nor_gl maps: green = image up
    s.N     = N;
    return s;
}

fn heightAt(uv: vec2<f32>, lod: f32) -> f32 {
    return textureSampleLevel(txHeight, samplerState, uv, lod).r;
}

fn insideBox(input: POMVertexOutput, p: vec3<f32>) -> bool {
    let d = p - input.BoxCenter;
    let local = abs(vec3<f32>(dot(d, input.BoxAxisX), dot(d, input.BoxAxisY), dot(d, input.BoxAxisZ)));
    return all(local <= input.BoxHalf + vec3<f32>(1e-4));
}

struct MarchHit {
    uv:     vec2<f32>,
    depth:  f32,   // fraction of the relief depth (0 = surface, 1 = deepest)
    exited: bool,  // the ray left the box before hitting (SILHOUETTE)
}

// Steps down from the surface (depth 0) to the deepest layer (1); uvRay / worldRay are
// the texture / world offsets of the view ray at depth 1. Linear refinement at the end.
fn march(input: POMVertexOutput, uv0: vec2<f32>, uvRay: vec2<f32>, worldRay: vec3<f32>,
         steps: f32, lod: f32) -> MarchHit {
    var hit: MarchHit;
    hit.exited = false;
    let n = i32(steps);
    let layer = 1.0 / steps;

    var prevDepth   = 0.0;
    var prevSurface = 1.0 - heightAt(uv0, lod);
    var depth   = 0.0;
    var surface = prevSurface;
    if (surface <= 0.0) {
        hit.uv = uv0;
        hit.depth = 0.0;
        return hit;
    }
    for (var i = 0; i < n; i++) {
        prevDepth   = depth;
        prevSurface = surface;
        depth += layer;
#ifdef SILHOUETTE
        if (!insideBox(input, input.WorldPos + worldRay * depth)) {
            hit.exited = true;
            break;
        }
#endif
        surface = 1.0 - heightAt(uv0 + uvRay * depth, lod);
        if (depth >= surface) {
            break;
        }
    }
    // Intersection of the ray with the segment between the last two samples.
    let before = prevSurface - prevDepth; // > 0: ray still above the relief
    let after  = depth - surface;         // >= 0: ray below
    let t = select(0.0, before / max(before + after, 1e-5), before + after > 0.0);
    hit.depth = mix(prevDepth, depth, t);
    hit.uv    = uv0 + uvRay * hit.depth;
    return hit;
}

// 1 = lit, 0 = fully shadowed by the relief between the hit and the sun.
fn reliefShadow(hit: MarchHit, sunUvRay: vec2<f32>, lod: f32) -> f32 {
    if (hit.depth <= 0.0) { return 1.0; }
    var occlusion = 0.0;
    for (var i = 1; i <= SHADOW_STEPS; i++) {
        let f = f32(i) / f32(SHADOW_STEPS);
        let rayDepth = hit.depth * (1.0 - f);
        let surface  = 1.0 - heightAt(hit.uv + sunUvRay * (hit.depth - rayDepth), lod);
        // Relief above the ray, weighted down with distance → soft penumbra.
        occlusion = max(occlusion, (rayDepth - surface) * (1.0 - f));
    }
    return 1.0 - saturate(occlusion * 12.0);
}

@fragment
fn fs(input: POMVertexOutput) -> FragmentOutput {
    // Derivatives first, in uniform control flow.
    let dPdx = dpdx(input.WorldPos);
    let dPdy = dpdy(input.WorldPos);
    let dUvdx = dpdx(input.Uv);
    let dUvdy = dpdy(input.Uv);

#ifdef BOX
    var surf = boxSurface(input);
    // From the position derivatives, not dpdx(uv): uv jumps where two faces share a quad.
    surf.duvdx = vec2<f32>(dot(dPdx, surf.dirU), dot(dPdx, surf.dirV)) * surf.scale;
    surf.duvdy = vec2<f32>(dot(dPdy, surf.dirU), dot(dPdy, surf.dirV)) * surf.scale;
#else
    var surf = meshSurface(input);
    surf.duvdx = dUvdx * vec2<f32>(factors.uvXScale, factors.uvYScale);
    surf.duvdy = dUvdy * vec2<f32>(factors.uvXScale, factors.uvYScale);
#endif

    // ── LOD: height mip and how many pixels the relief spans there ────────────
    let heightSize = vec2<f32>(textureDimensions(txHeight, 0));
    let footprint  = max(length(surf.duvdx * heightSize), length(surf.duvdy * heightSize));
    let lod        = max(log2(max(footprint, 1e-6)) + camera.mipBias, 0.0);
    let texelsPerUv = heightSize.x * exp2(-lod);
    // Relief thinner than ~half a pixel is invisible: fade the depth (not the uv), skip.
    let reliefPx = factors.pomScale * surf.scale * texelsPerUv;
    let depthScale = factors.pomScale * smoothstep(0.35, 1.5, reliefPx);

    let V  = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let vz = max(dot(V, surf.N), MIN_VIEW_COS);

    var uvFinal = surf.uv;
    var shadow  = 1.0;
    if (depthScale > 0.0) {
        let uvRay    = -vec2<f32>(dot(V, surf.dirU), dot(V, surf.dirV)) / vz * depthScale * surf.scale;
        let worldRay = -V / vz * depthScale;
        let pxTravel = length(uvRay) * texelsPerUv;
        let steps    = clamp(max(pxTravel, reliefPx) * 0.75 + MIN_STEPS, MIN_STEPS, MAX_STEPS);

        let hit = march(input, surf.uv, uvRay, worldRay, steps, lod);
        if (hit.exited) {
            discard;
        }
        uvFinal = hit.uv;

#ifdef POM_SHADOW
        let S  = camera.sunDirection.xyz;
        let sz = dot(S, surf.N);
        if (camera.sunDirection.w > 0.0 && factors.pomShadow > 0.0 && sz > 0.0) {
            let sunUvRay = vec2<f32>(dot(S, surf.dirU), dot(S, surf.dirV)) / max(sz, MIN_VIEW_COS)
                         * depthScale * surf.scale;
            shadow = mix(1.0, reliefShadow(hit, sunUvRay, lod), factors.pomShadow);
        }
#endif
    }

    // ── Texture sampling with the undisplaced gradients ───────────────────────
    // dpdx of the displaced uv jumps at relief steps and picks tiny mips there (sparkles
    // along every stone edge). Texture UVs keep the camera jitter on purpose: TAA/TSR
    // integrate the sub-pixel offsets; camera.mipBias compensates their blur.
    let g    = exp2(camera.mipBias);
    let gx   = surf.duvdx * g;
    let gy   = surf.duvdy * g;
    let albedo_color  = textureSampleGrad(txAlbedo,    samplerState, uvFinal, gx, gy);
    let metallic_raw  = textureSampleGrad(txMetallic,  samplerState, uvFinal, gx, gy).b;
    let roughness_raw = textureSampleGrad(txRoughness, samplerState, uvFinal, gx, gy).g;
    let N_ts          = textureSampleGrad(txNormal,    samplerState, uvFinal, gx, gy).xyz * 2.0 - 1.0;
    let emissive_raw  = textureSampleGrad(txEmissive,  samplerState, uvFinal, gx, gy).x;

    let N = normalize(surf.mapT * N_ts.x + surf.mapB * N_ts.y + surf.N * N_ts.z);

    // ── Specular anti-aliasing (same as gbuffer.fs) ───────────────────────────
    let dndx         = dpdx(N);
    let dndy         = dpdy(N);
    let variance     = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2 = min(2.0 * variance * 0.25, 0.18);
    let rough2       = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness    = sqrt(rough2);

    var output: FragmentOutput;
    // Albedo is bound through an sRGB view: the hardware already decoded it to linear.
    output.albedo = vec4<f32>(albedo_color.rgb * factors.baseColorFactor.rgb * shadow,
                              metallic_raw * factors.metallicFactor);
    output.normal = vec4<f32>(normalToOctahedral01(N), roughness * factors.roughnessFactor,
                              emissive_raw * factors.emissiveFactor);

    // Geometric depth = top of the relief (see header). Pushing it down to the hit would
    // make the shadow-map test see the mesh's own surface above every crack.
    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    output.depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    return output;
}
