struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
}

struct VertexOutputTriplanarLocal {
    @builtin(position) position: vec4<f32>,

    @location(0) @interpolate(perspective, centroid) localNormal: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) localPos: vec3<f32>,
    @location(2) @interpolate(perspective, centroid) worldPos: vec3<f32>,

    // Normal matrix como 3 columnas (col0, col1, col2)
    @location(3) @interpolate(perspective, centroid) normalMatrix0: vec3<f32>,
    @location(4) @interpolate(perspective, centroid) normalMatrix1: vec3<f32>,
    @location(5) @interpolate(perspective, centroid) normalMatrix2: vec3<f32>,
}

struct ShadowsVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) worldPos: vec3<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
    @location(1) normal: vec4<f32>,     // RG: octahedral normal, BA: roughness + emissive
    @location(2) depth: f32,      // Linear depth (view space)
}

struct GBuffer {
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    specularColor: vec3<f32>,
    roughness: f32,
    selfIllum: vec3<f32>,
    emissive: f32,
    reflectedDir: vec3<f32>,
    viewDir: vec3<f32>,
    metallic: f32,
    zlinear: f32,
}

struct MaterialFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,  // decal: blend weight for albedo+normal (1=full, 0=no change)
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,     // decal: blend weight for roughness+metallic (1=full, 0=no change)
    pomScale: f32          // POM height scale (0 = disabled, typical 0.01-0.1)
}

struct SSRUniforms {
    globalAmbientBoost: f32,
    stepSize: f32,
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    specularBoost: f32,
    diffuseBoost: f32,
    metallicMin: f32,
    roughnessMax: f32,
    temporalMode: f32,  // 1.0 = TAA active (halve march steps), 0.0 = standalone
    frameIndex: f32,    // incremented each frame — drives blue-noise temporal animation
}
// Matrix utility functions
// Level 1: No dependencies

// Extract 3x3 rotation/scale from 4x4 transformation matrix
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

// Compute TBN (Tangent-Bitangent-Normal) matrix for normal mapping
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
}

fn sign_nonzero_f(v: f32) -> f32 {
    return select(-1.0, 1.0, v >= 0.0);
}



fn encodeOctahedral(n: vec3<f32>) -> vec2<f32> {
    // Proyección octahedral: divide por la norma L1
    var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    // Wrap para hemisferio negativo Z
    if (n.z < 0.0) {
        p = (1.0 - abs(p.yx)) * sign_nonzero(p);
    }
    return p;  // rango [-1, 1]
}

fn decodeOctahedral(p: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    if (n.z < 0.0) {
        let tmp = n.xy;
        n.x = (1.0 - abs(tmp.y)) * sign_nonzero_f(tmp.x);
        n.y = (1.0 - abs(tmp.x)) * sign_nonzero_f(tmp.y);
    }
    return normalize(n);
}

// sign que devuelve +1 cuando x=0 (necesario para el wrap)
fn sign_nonzero(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0)
    );
}

fn normalToOctahedral01(n: vec3<f32>) -> vec2<f32> {
    return encodeOctahedral(n) * 0.5 + 0.5;
}

fn octahedral01ToNormal(enc: vec2<f32>) -> vec3<f32> {
    return decodeOctahedral(enc * 2.0 - 1.0);
}

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

// Computes the correct mip level for a UV + texture size pair.
// Must be called BEFORE any non-uniform control flow (if/loop with break)
// because dpdx/dpdy are undefined inside divergent flow.
fn computeMipLevel(uv: vec2<f32>, texSize: vec2<f32>) -> f32 {
    let dx = dpdx(uv * texSize);
    let dy = dpdy(uv * texSize);
    let deltaMax = max(dot(dx, dx), dot(dy, dy));
    return 0.5 * log2(max(deltaMax, 1e-6));
}

fn parallaxOcclusionMapping(
    uv:          vec2<f32>,
    viewDirTS:   vec3<f32>,   // normalised, pointing toward camera
    pomScale:    f32,
    minSamples:  f32,
    maxSamples:  f32,
    mipLevel:    f32,         // pre-computed before non-uniform flow
) -> vec2<f32> {
    // Quadratic cosAngle: allocates more samples at grazing angles more aggressively
    // than the linear version, reducing banding when the UV delta per step is large.
    let cosAngle    = saturate(viewDirTS.z);  // dot(viewDir, tangent-space N = (0,0,1))
    let numSamples  = mix(maxSamples, minSamples, cosAngle * cosAngle);
    let numSamplesI = max(i32(numSamples), 1);

    // Per-layer step sizes.
    let layerDepth  = 1.0 / numSamples;
    // UV shift per layer along the view ray projected onto the height field.
    // viewDirTS.z is the component perpendicular to the surface — divide to
    // un-project so the XY shift matches the geometric slope at any angle.
    // Clamp z to 0.2 (~78° max from normal) — beyond this angle POM can't work
    // reliably without tile-crossing artifacts, so we simply stop extrapolating further.
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
        currentHeight        = textureSampleLevel(txHeight, samplerState, currentUV, mipLevel).r;
        if (currentLayerDepth >= currentHeight) {
            break;
        }
    }

    // ── Step 2: Linear refinement for sub-layer precision ─────────────────────
    var prevUV    = currentUV - uvDelta;
    var prevDepth = currentLayerDepth - layerDepth;

    // Interpolation weight: how far the intersection is between prev and current.
    let afterDepth  = currentHeight - currentLayerDepth;
    let prevSample  = textureSampleLevel(txHeight, samplerState, prevUV, mipLevel).r;
    let beforeDepth = prevSample - prevDepth;
    let weight      = afterDepth / (afterDepth - beforeDepth);

    return mix(currentUV, prevUV, weight);
}

// ─────────────────────────────────────────────────────────────────────────────

@fragment
fn fs(input: POMVertexOutput) -> FragmentOutput {
    let pomScale     = factors.pomScale;
    let pomMinSamps  = 8.0;
    // Scale max samples with pomScale: higher displacement needs more steps to avoid
    // banding. Clamped to 64 for performance. pomScale=0.02→24, 0.05→60, 0.08→64.
    let pomMaxSamps  = clamp(pomScale * 1200.0, 16.0, 64.0);

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

    // ── Mip level for heightmap ───────────────────────────────────────────────
    // Computed HERE (uniform flow) because dpdx/dpdy are invalid inside the
    // if-block below (non-uniform control flow). Using mip 0 throughout the
    // march causes the heightmap to disagree with the mipped albedo/normal at
    // distance, producing the "stones rise as you approach" artifact.
    let heightTexSize = vec2<f32>(textureDimensions(txHeight, 0));
    let heightMip     = max(computeMipLevel(baseUv, heightTexSize) + camera.mipBias, 0.0);

    // Fade POM to zero at very grazing angles (viewDirTS.z → 0) to prevent UV explosions.
    // Range is tighter than before: at z=0.1 we already have full POM, so more of the
    // surface gets displacement.  The mip level rising with distance/angle naturally
    // blurs the heightmap at extreme angles, bounding the effect without a hard cutoff.
    let grazingFade = smoothstep(0.02, 0.1, viewDirNorm.z);
    let finalFade   = grazingFade;

    if (pomScale > 0.0 && finalFade > 0.001) {
        let pomUv = parallaxOcclusionMapping(
            baseUv,
            viewDirNorm,
            pomScale,
            pomMinSamps,
            pomMaxSamps,
            heightMip,
        );

        // ── Silhouette clipping ───────────────────────────────────────────────
        // Must use pomUv (raw POM result) NOT dispUv.
        // dispUv = mix(baseUv, pomUv, grazingFade): at grazing angles where the
        // ray is most likely to exit the mesh, grazingFade → 0 and dispUv ≈ baseUv
        // which is always in-bounds — the check would never fire.
        // pomUv is the actual ray intersection: if it exits [0, meshMax] the
        // view ray left the mesh, which means the fragment belongs to the silhouette
        // zone and should be clipped if the heightmap shows solid geometry at the edge.
        let meshMax = vec2<f32>(factors.uvXScale, factors.uvYScale);
        if (any(pomUv < vec2<f32>(0.0)) || any(pomUv > meshMax)) {
            // Clamp to the nearest in-bounds texel (repeat sampler fract()s this
            // into [0,1] texture space automatically, landing near the tile edge).
            let borderUV   = clamp(pomUv, vec2<f32>(0.001), meshMax - vec2<f32>(0.001));
            let edgeHeight = textureSampleLevel(txHeight, samplerState, borderUV, 0.0).r;
            if (edgeHeight > 0.05) {
                discard;
            }
        }

        dispUv = mix(baseUv, pomUv, finalFade);
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

    // ── GBuffer packing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    var output: FragmentOutput;

    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo     = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, metallic_raw * factors.metallicFactor);
    output.normal     = vec4<f32>(normalToOctahedral01(N), roughness * factors.roughnessFactor, emissive_raw * factors.emissiveFactor);

    // ── GBuffer depth (geometric, no correction) ─────────────────────────────
    // We use the geometric mesh position, NOT the displaced surface position.
    // Correcting linear depth to the displaced position would push low-height
    // pixels (mortar, cracks) behind the geometric surface.  The lighting pass
    // reconstructs worldPos from this value and uses it for shadow map lookups;
    // pushing it deeper makes the shadow test think those pixels are occluded by
    // their own mesh → artificial dark self-shadowing on every mortar crack.
    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    output.depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;

    return output;
}
