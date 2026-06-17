// Screen-Space Reflections — Hi-Z compute shader
//
// Improvements over the previous view-space linear march:
//   • Screen-space DDA: advances a constant number of PIXELS per step (not world units),
//     giving uniform sampling density at all depths and view angles.
//   • Hi-Z pyramid skip: at coarse mip levels each iteration covers 2/4/8/16 pixels;
//     empty screen regions are traversed in far fewer iterations than with fixed steps.
//   • Binary-search refinement (8 iters) retained for sub-pixel hit accuracy.
//
// Bind-group layout (unchanged from previous version):
//   group(0)  Camera uniforms         (CameraUniforms UBO)
//   group(1)  G-Buffer                (albedo, normals, linearDepth, sampler)
//   group(2)  SSR params + inputs     (accLight, SSRUniforms UBO, blueNoise, hizTex)
//   group(3)  Output storage tex      (rgba16float write-only)

#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

// ── Group 0: camera ───────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ── Group 1: G-Buffer ─────────────────────────────────────────────────────────
@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// ── Group 2: SSR params ───────────────────────────────────────────────────────
@group(2) @binding(0) var accLight:           texture_2d<f32>;
@group(2) @binding(1) var<uniform> ssrParams: SSRUniforms;
@group(2) @binding(2) var txBlueNoise:        texture_2d<f32>;
// Hi-Z min-depth pyramid (r32float, 4 mip levels = half/quarter/eighth/sixteenth res).
// Built from gLinearDepth each frame before the SSR dispatch.
// hizTex mip k corresponds to full-pyramid level (k+1); full-pyramid level 0 = gLinearDepth.
@group(2) @binding(3) var hizTex: texture_2d<f32>;

// ── Group 3: output ───────────────────────────────────────────────────────────
@group(3) @binding(0) var outputSSR: texture_storage_2d<rgba16float, write>;

// ─────────────────────────────────────────────────────────────────────────────

// Max pyramid level used during traversal.
// Level 0 = gLinearDepth (full res), level 1-4 = hizTex mips 0-3.
const MAX_HIZ: i32 = 4;

// ── Blue-noise helpers ───────────────────────────────────────────────────────
fn sampleBlueNoise(coord: vec2<u32>) -> vec2<f32> {
    let frame = u32(ssrParams.frameIndex);
    let nc    = vec2<i32>(
        i32((coord.x + frame * 17u) & 63u),
        i32((coord.y + frame * 11u) & 63u),
    );
    return textureLoad(txBlueNoise, nc, 0).rg;
}

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fade = min(uv, vec2<f32>(1.0) - uv) / 0.1;
    return saturate(fade.x) * saturate(fade.y);
}

// ── View↔screen helpers ──────────────────────────────────────────────────────

// View-space position → (screenUV, normalised linear depth [0,1])
fn viewToScreen(viewPos: vec3<f32>) -> vec3<f32> {
    let clip  = camera.projectionMatrix * vec4<f32>(viewPos, 1.0);
    let ndc   = clip.xyz / clip.w;
    var uv    = ndc.xy * 0.5 + 0.5;
    uv.y      = 1.0 - uv.y;
    let depth = -viewPos.z / camera.cameraFar;
    return vec3<f32>(uv, depth);
}

// (screenUV, normalised linear depth) → view-space position
fn screenToView(uv: vec2<f32>, linearDepth: f32) -> vec3<f32> {
    let ndc   = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    let viewZ = -linearDepth * camera.cameraFar;
    let viewX = ndc.x * (-viewZ) / camera.projectionMatrix[0][0];
    let viewY = ndc.y * (-viewZ) / camera.projectionMatrix[1][1];
    return vec3<f32>(viewX, viewY, viewZ);
}

// ── Hi-Z hierarchy sampler ───────────────────────────────────────────────────
// level 0  → gLinearDepth (full res);  sky depth=0 remapped to 1.0.
// level 1-4 → hizTex mip (level-1);   already sky-remapped during build.
fn sampleHiZ(uv: vec2<f32>, level: i32) -> f32 {
    if (level <= 0) {
        let dims  = vec2<i32>(textureDimensions(gLinearDepth));
        let coord = clamp(vec2<i32>(uv * vec2<f32>(dims)),
                          vec2<i32>(0), dims - vec2<i32>(1));
        let d = textureLoad(gLinearDepth, coord, 0).r;
        return select(1.0, d, d > 0.0001);
    }
    let hizLvl  = clamp(level - 1, 0, MAX_HIZ - 1);
    let baseDims = vec2<i32>(textureDimensions(hizTex));           // mip-0 dims of hizTex
    let mipDims  = max(vec2<i32>(1), baseDims >> vec2<u32>(u32(hizLvl)));
    let coord    = clamp(vec2<i32>(uv * vec2<f32>(mipDims)),
                         vec2<i32>(0), mipDims - vec2<i32>(1));
    return textureLoad(hizTex, coord, hizLvl).r;
}

// ── Binary-search refinement (view space) ───────────────────────────────────
fn binarySearchRefine(loVP: vec3<f32>, hiVP: vec3<f32>) -> vec3<f32> {
    var lo = loVP;
    var hi = hiVP;
    for (var j: i32 = 0; j < 8; j++) {
        let midVP  = (lo + hi) * 0.5;
        let midScr = viewToScreen(midVP);
        if (midScr.x < 0.0 || midScr.x > 1.0 || midScr.y < 0.0 || midScr.y > 1.0) { break; }
        let sceneDep      = textureLoad(gLinearDepth,
                                        clamp(vec2<i32>(midScr.xy * vec2<f32>(textureDimensions(gLinearDepth))),
                                              vec2<i32>(0),
                                              vec2<i32>(textureDimensions(gLinearDepth)) - vec2<i32>(1)),
                                        0).r;
        let midThickness  = ssrParams.thickness * (1.0 + sceneDep * 2.0);
        if (midScr.z > sceneDep && (midScr.z - sceneDep) < midThickness) {
            hi = midVP;
        } else {
            lo = midVP;
        }
    }
    return hi;
}

// ── Screen-space Hi-Z ray march ───────────────────────────────────────────────
//
// The ray is parameterised in SCREEN SPACE (UV + linear depth), stepping by a
// fixed number of PIXELS per iteration in the dominant screen axis.  The Hi-Z
// hierarchy allows coarse iterations (up to 16 px/step) over empty regions and
// automatically narrows to 1 px/step near a potential hit.
//
// After a confirmed hit the position is refined in VIEW SPACE via binary search
// (carried over from the previous shader) for sub-step accuracy.
fn performSSRHiZMarch(
    worldPos:     vec3<f32>,
    reflWorld:    vec3<f32>,
    roughness:    f32,
    ditherOffset: f32,
    ssrDims:      vec2<f32>,
) -> vec4<f32> {
    // Transform to view space
    let viewStartRaw = (camera.viewMatrix * vec4<f32>(worldPos, 1.0)).xyz;
    let viewDir      = normalize((camera.viewMatrix * vec4<f32>(reflWorld, 0.0)).xyz);
    if (viewDir.z > 0.0) { return vec4<f32>(0.0); }

    let rayStartDepth = -viewStartRaw.z / camera.cameraFar;

    // Small self-intersection offset + blue-noise dither within [0, stepSize)
    let viewStart = viewStartRaw + viewDir * (0.05 + ditherOffset);

    // Screen-space start and end of the ray
    let startScr = viewToScreen(viewStart);
    let endVP    = viewStart + viewDir * ssrParams.maxDistance;
    let endScr   = viewToScreen(endVP);

    if (startScr.x < 0.0 || startScr.x > 1.0 ||
        startScr.y < 0.0 || startScr.y > 1.0) {
        return vec4<f32>(0.0);
    }

    // Screen-space delta, normalised so one step = 1 pixel in dominant axis
    let scrDelta  = endScr.xy - startScr.xy;
    let pxDelta   = scrDelta * ssrDims;
    let pxLen     = max(abs(pxDelta.x), abs(pxDelta.y));
    if (pxLen < 1.0) { return vec4<f32>(0.0); }

    // Budget: up to ssrParams.maxSteps * 16 screen pixels, capped at screen width
    let maxPx     = min(ssrParams.maxSteps * 16.0, ssrDims.x * 0.9);
    let stepUV    = scrDelta / pxLen;         // UV advance per 1 pixel step
    let stepDepth = (endScr.z - startScr.z) / pxLen; // depth advance per 1 pixel step

    // Apply blue-noise sub-pixel offset to the starting position
    let noiseShift = ditherOffset * 4.0;
    var pos        = startScr.xy + stepUV    * noiseShift;
    var depth      = startScr.z  + stepDepth * noiseShift;
    var prevPos    = pos;
    var prevDepth  = depth;

    var mip        = MAX_HIZ;       // start at coarsest level
    var pixelsTrav = 0.0;           // total screen pixels traversed

    // Safety cap on loop iterations: coarse steps rarely need more than maxSteps * 6
    let maxIter = i32(ssrParams.maxSteps) * 6;

    for (var i = 0; i < maxIter; i++) {
        if (pixelsTrav >= maxPx)                                    { break; }
        if (pos.x < 0.0 || pos.x > 1.0 ||
            pos.y < 0.0 || pos.y > 1.0)                            { break; }
        if (depth <= 0.0 || depth >= 1.0)                          { break; }

        let hiZ = sampleHiZ(pos, mip);

        if (depth > hiZ) {
            // ── Ray is below the min-depth of this Hi-Z cell → potential hit ──
            if (mip <= 0) {
                // Finest level: confirm with full thickness/depth checks
                let adaptiveThickness = ssrParams.thickness * (1.0 + hiZ * 2.0);
                if ((depth - hiZ) < adaptiveThickness && hiZ > rayStartDepth) {
                    // Real hit — refine in view space then sample
                    let loVP       = screenToView(prevPos, prevDepth);
                    let hiVP       = screenToView(pos,     depth);
                    let refinedVP  = binarySearchRefine(loVP, hiVP);
                    let refinedScr = viewToScreen(refinedVP);
                    if (refinedScr.x < 0.0 || refinedScr.x > 1.0 ||
                        refinedScr.y < 0.0 || refinedScr.y > 1.0) {
                        return vec4<f32>(0.0);
                    }
                    let hitColor  = textureSampleLevel(accLight, samplerGBuffer, refinedScr.xy, 0.0);
                    let edgeFade  = calculateEdgeFade(refinedScr.xy);
                    let roughFade = 1.0 - smoothstep(0.0, 0.4, roughness);
                    return vec4<f32>(hitColor.rgb, edgeFade * roughFade);
                }
                // False positive (too thick, or hit object behind reflector).
                // Advance one fine step and try a slightly coarser level to escape.
                prevPos = pos; prevDepth = depth;
                pos       += stepUV;
                depth     += stepDepth;
                pixelsTrav += 1.0;
                mip = min(mip + 1, MAX_HIZ);
            } else {
                // Go finer to localise the hit — do NOT advance position
                mip -= 1;
            }
        } else {
            // ── No hit in this Hi-Z cell → advance one full cell ──
            let cellPx = f32(1 << u32(mip));  // 1, 2, 4, 8, or 16 pixels
            prevPos = pos; prevDepth = depth;
            pos       += stepUV    * cellPx;
            depth     += stepDepth * cellPx;
            pixelsTrav += cellPx;
            // Bump mip up: if the next cell is also empty we'll skip even faster
            mip = min(mip + 1, MAX_HIZ);
        }
    }

    return vec4<f32>(0.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main compute entry — workgroup 8×8, one thread per output pixel
// ─────────────────────────────────────────────────────────────────────────────
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims   = vec2<i32>(textureDimensions(outputSSR));
    let coords = vec2<i32>(gid.xy);
    if (coords.x >= dims.x || coords.y >= dims.y) { return; }

    let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dims);

    // Cheap sky / disabled early exit
    let rawDepth = textureLoad(gLinearDepth,
                               clamp(vec2<i32>(uv * vec2<f32>(textureDimensions(gLinearDepth))),
                                     vec2<i32>(0),
                                     vec2<i32>(textureDimensions(gLinearDepth)) - vec2<i32>(1)),
                               0).r;
    if (ssrParams.enabled < 0.5 || rawDepth < 0.0001) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    let g = decodeGBuffer(uv);

    let metallicFade = saturate((g.metallic - 0.1) / 0.3);
    if (g.metallic < ssrParams.metallicMin || g.roughness > ssrParams.roughnessMax) {
        textureStore(outputSSR, coords, vec4<f32>(0.0));
        return;
    }

    // Mip-smoothed normal to suppress high-frequency normal-map noise
    let smoothMip     = clamp(1.0 + g.roughness * 3.0, 1.0, 5.0);
    let smoothNData   = textureSampleLevel(gNormals, samplerGBuffer, uv, smoothMip);
    let smoothN       = normalize(octahedral01ToNormal(smoothNData.xy));
    let incidentDir   = normalize(g.worldPos - camera.cameraPosition.xyz);
    let smoothReflDir = normalize(reflect(incidentDir, smoothN));

    // Blue-noise stochastic offsets (frame-animated for temporal accumulation)
    let noise = sampleBlueNoise(vec2<u32>(gid.xy));

    let ditherOffset = noise.x * ssrParams.stepSize;

    let jitterRadius = min(g.roughness * g.roughness * 0.4, 0.15);
    var jitteredDir  = smoothReflDir;
    if jitterRadius > 0.001 {
        let up        = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0),
                               abs(smoothReflDir.y) < 0.99);
        let tangent   = normalize(cross(up, smoothReflDir));
        let bitangent = cross(smoothReflDir, tangent);
        let angle     = noise.y * 6.28318530718;
        jitteredDir   = normalize(smoothReflDir
                                  + tangent   * cos(angle) * jitterRadius
                                  + bitangent * sin(angle) * jitterRadius);
    }

    let ssrDims = vec2<f32>(dims);
    let result  = performSSRHiZMarch(g.worldPos, jitteredDir, g.roughness, ditherOffset, ssrDims);
    textureStore(outputSSR, coords, vec4<f32>(result.rgb, result.a * metallicFade));
}
