#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

// ── Group 0: Camera ──────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ── Group 1: Material textures (custom-slot path) ────────────────────────────
@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var txHeight:    texture_2d<f32>;   // R = height (0=low, 1=high)
@group(1) @binding(6) var samplerState: sampler;
@group(1) @binding(7) var<uniform> factors: MaterialFactors;

// Reuse the same vertex output struct declared in the VS.
struct POMVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    @location(4) @interpolate(perspective, centroid) ViewDirTS: vec3<f32>,
}

// ── Parallax Occlusion Mapping ───────────────────────────────────────────────
//
// Classic steep-POM + binary-search refinement (Policarpo & Fonseca 2005).
// 1. March N steps along the view ray in tangent space.
// 2. Find the first step where the ray dips below the height field.
// 3. Binary-search between the last-above and first-below steps for precision.
// 4. Return the displaced UV at that intersection.
//
fn parallaxOcclusionMapping(
    uv:          vec2<f32>,
    viewDirTS:   vec3<f32>,   // normalised, pointing toward camera
    pomScale:    f32,
    minSamples:  f32,
    maxSamples:  f32,
) -> vec2<f32> {
    // Number of samples scales with grazing angle: more samples when the view
    // is nearly parallel to the surface (where layer aliasing is worst).
    let cosAngle    = saturate(viewDirTS.z);  // dot(viewDir, tangent-space N = (0,0,1))
    let numSamples  = mix(maxSamples, minSamples, cosAngle);
    let numSamplesI = max(i32(numSamples), 1);

    // Per-layer step sizes.
    let layerDepth  = 1.0 / numSamples;
    // UV shift per layer along the view ray projected onto the height field.
    // viewDirTS.z is the component perpendicular to the surface — divide to
    // un-project so the XY shift matches the geometric slope at any angle.
    // Clamp z to 0.2 (~78° max from normal) — beyond this angle POM can't work
    // reliably without tile-crossing artifacts, so we simply stop extrapolating further.
    let viewClamped = vec3<f32>(viewDirTS.xy, max(viewDirTS.z, 0.2));
    let uvDelta = (viewDirTS.xy / max(viewDirTS.z, 0.2)) * pomScale * layerDepth;

    var currentLayerDepth: f32 = 0.0;
    var currentUV         = uv;
    var currentHeight     = 0.0;

    // ── Step 1: Steep parallax — advance first, then check ───────────────────
    // Advancing before sampling ensures the first iteration is never skipped
    // when the height map starts at 0.0 (fully displaced surface).
    for (var i = 0; i < numSamplesI; i++) {
        currentUV           += uvDelta;
        currentLayerDepth   += layerDepth;
        currentHeight        = textureSampleLevel(txHeight, samplerState, currentUV, 0.0).r;
        if (currentLayerDepth >= currentHeight) {
            break;
        }
    }

    // ── Step 2: Binary search for sub-layer precision ─────────────────────────
    var prevUV    = currentUV - uvDelta;
    var prevDepth = currentLayerDepth - layerDepth;

    // Interpolation weight: how far the intersection is between prev and current.
    // (relief mapping linear interpolation — fast and good enough for games)
    let afterDepth  = currentHeight - currentLayerDepth;
    let prevSample  = textureSampleLevel(txHeight, samplerState, prevUV, 0.0).r;
    let beforeDepth = prevSample - prevDepth;
    let weight      = afterDepth / (afterDepth - beforeDepth);

    return mix(currentUV, prevUV, weight);
}

// ─────────────────────────────────────────────────────────────────────────────

@fragment
fn fs(input: POMVertexOutput) -> FragmentOutput {
    let pomScale     = factors.pomScale;
    let pomMinSamps  = 8.0;
    let pomMaxSamps  = 32.0;

    // ── Parallax UV displacement ──────────────────────────────────────────────
    let baseUv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    var dispUv = baseUv;
    // Recompute ViewDirTS per-fragment using the same TBN path as normal mapping.
    // This is essential: the VS-interpolated value uses per-vertex TBN which does
    // not match the per-fragment TBN used below, producing radial artifacts.
    let TBN_pom    = computeTBN(normalize(input.N), input.T);
    let tbnInv     = transpose(TBN_pom);
    let vdWS       = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let viewDirTS  = normalize(tbnInv * vdWS);
    let viewDirNorm = viewDirTS;
    // Fade POM to zero at grazing angles (viewDirTS.z → 0) to prevent explosions.
    let grazingFade  = smoothstep(0.05, 0.25, viewDirNorm.z);
    if (pomScale > 0.0 && grazingFade > 0.001) {
        let pomUv = parallaxOcclusionMapping(
            baseUv,
            viewDirNorm,
            pomScale,
            pomMinSamps,
            pomMaxSamps,
        );
        dispUv = mix(baseUv, pomUv, grazingFade);
    }

    // ── UV unjittering (same as gbuffer.fs) ───────────────────────────────────
    let jitter_px   = camera.jitterOffset * camera.screenSize;
    let uvFinal     = dispUv - dpdx(dispUv) * jitter_px.x - dpdy(dispUv) * jitter_px.y;

    // ── Texture sampling ──────────────────────────────────────────────────────
    let albedo_color  = textureSampleBias(txAlbedo,    samplerState, uvFinal, camera.mipBias);
    let metallic_raw  = textureSampleBias(txMetallic,  samplerState, uvFinal, camera.mipBias).b;
    let roughness_raw = textureSampleBias(txRoughness, samplerState, uvFinal, camera.mipBias).g;
    let N_ts_raw      = textureSampleBias(txNormal,    samplerState, uvFinal, camera.mipBias) * 2.0 - 1.0;
    let emissive_raw  = textureSampleBias(txEmissive,  samplerState, uvFinal, camera.mipBias).x;

    // ── Normal mapping ────────────────────────────────────────────────────────
    let TBN = computeTBN(normalize(input.N), input.T);
    let N   = normalize(TBN * N_ts_raw.xyz);

    // ── Specular Anti-Aliasing (same as gbuffer.fs) ───────────────────────────
    let dndx        = dpdx(N);
    let dndy        = dpdy(N);
    let variance    = dot(dndx, dndx) + dot(dndy, dndy);
    let saaBias     = 0.25;
    let kernelRough2 = min(2.0 * variance * saaBias, 0.18);
    let rough2      = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness   = sqrt(rough2);

    // ── GBuffer packing ───────────────────────────────────────────────────────
    var output: FragmentOutput;

    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo     = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, metallic_raw * factors.metallicFactor);
    output.normal     = vec4<f32>(normalToOctahedral01(N), roughness * factors.roughnessFactor, emissive_raw * factors.emissiveFactor);

    let camb2obj      = input.WorldPos - camera.cameraPosition.xyz;
    output.depth      = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;

    return output;
}
