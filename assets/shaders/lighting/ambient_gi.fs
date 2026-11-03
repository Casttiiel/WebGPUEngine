// Ambient diffuse with realtime GI (RealtimeGI.renderDiffuse) — same contract as ambient.fs
// (clears accLight to ambient + self-illumination). The irradiance comes from the GI resolve
// (gi/gi_resolve.cs, reduced resolution), upsampled here with depth/normal-aware weights so it
// doesn't bleed across edges. In compare mode the left side uses the baked probes exactly as
// ambient.fs does.
// GI_DIRECT (RealtimeGI.renderDiffuseDirect, the water G-buffer): no resolve — the probe
// volumes are sampled per pixel (group 3, GISharedResources), baked probes fill the rest.

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
    // Scene sun (offset 116 = byte 464): xyz = direction toward the sun, w = 1 if present.
    sunDirection: vec4<f32>,
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
    environmentIntensity: f32, // scale of the reflected environment (IBL path)
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
// Complete BRDF calculations for PBR lighting
// Level 3: Depends on pbr/core

// Core PBR functions: Normal Distribution, Geometry, Fresnel
// Level 2: Depends on core/constants

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

// Basic math utility functions
// Level 0: No dependencies

// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}


// GGX/Trowbridge-Reitz Normal Distribution Function
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a2 = roughness * roughness;
    let NdotH2 = NdotH * NdotH;
    
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    
    return num / denom;
}

// Smith-Schlick-GGX Geometry Function (Uncorrelated)
fn Geometric_Smith_Schlick_GGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    
    let ggx2 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx1 = NdotL / (NdotL * (1.0 - k) + k);
    
    return ggx1 * ggx2;
}

// Smith-GGX Geometry Function (Height-Correlated)
fn Geometry_SmithGGX_Correlated(NdV: f32, NdL: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let gv = NdL * sqrt(NdV * (NdV - NdV * a) + a);
    let gl = NdV * sqrt(NdL * (NdL - NdL * a) + a);
    return 0.5 / max(gv + gl, EPSILON);
}

// Schlick's Fresnel approximation
fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

// Fresnel with roughness factor for IBL
fn Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let oneMinusRoughness = 1.0 - roughness;
    return F0 + (max(vec3f(oneMinusRoughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


// Cook-Torrance Specular BRDF
fn Specular(specularColor: vec3<f32>, h: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughnessSquared: f32, NdL: f32, NdV: f32, NdH: f32, VdH: f32, LdV: f32) -> vec3<f32> {
    let F0 = specularColor;
    let roughness = sqrt(roughnessSquared);
    
    let NDF = NormalDistribution_GGX(NdH, roughness);
    let G = Geometric_Smith_Schlick_GGX(NdV, NdL, roughness);
    let F = Fresnel_Schlick(VdH, F0);
    
    let numerator = NDF * G * F;
    let denominator = 4.0 * NdV * NdL + EPSILON;
    
    return numerator / denominator;
}

// Lambertian Diffuse BRDF
fn Diffuse(pAlbedo: vec3<f32>) -> vec3<f32> {
    return pAlbedo * INV_PI;
}

// Half Lambert: remaps NdL [0,1] → [0.25,1] to soften the shadow terminator
// and wrap light around the back of surfaces. Based on Valve's HL2 technique.
fn halfLambert(NdL: f32) -> f32 {
    let h = NdL * 0.5 + 0.5;
    return h * h;
}

// Micro-shadow term (Jimenez 2016, "Practical Realtime Strategies for Accurate
// Indirect Occlusion", eq. 18).
// Converts baked AO to the cosine of the hemisphere cone half-angle and compares
// it against NdotL so that geometry encoded in normal/AO maps casts a shadow on
// direct illumination — at essentially zero GPU cost (one sqrt + one divide).
//
// ao    : AO value [0..1], where 0 = fully occluded, 1 = fully exposed.
// NdotL : dot(N, L) clamped to [0..1].
// Returns a visibility factor in [0..1] that attenuates the direct contribution
// in concave areas without affecting IBL (which is already modulated by AO).
fn microShadow(ao: f32, NdotL: f32) -> f32 {
    let cosTheta = sqrt(1.0 - ao);   // cos of AO cone half-angle (eq. 18)
    return saturate(NdotL / (cosTheta + 0.0001));
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
// Coordinate transformation utilities
// Level 1: Depends on core/constants, core/uniforms




// Reconstruct world position from UV, depth, and camera
fn getWorldCoords(uv: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
    // Convert UV coordinates (0-1) to NDC coordinates (-1 to 1)
    let coords = vec2<f32>(uv.x, 1.0 - uv.y);
    let ndc_coords = (coords * 2.0) - 1.0;
    
    // Get the ray direction by transforming NDC coordinates
    let near_ndc = vec4<f32>(ndc_coords.x, ndc_coords.y, 1.0, 1.0);
    let near_world_homogeneous = camera.invViewProjection * near_ndc;
    let near_world = near_world_homogeneous.xyz / near_world_homogeneous.w;

    // Calculate the ray direction from camera to the point (in WORLD coordinates)
    let ray_direction = normalize(near_world - camera.cameraPosition.xyz);
    
    // zlinear was calculated as: dot(worldPos - cameraPos, cameraFront) / zFar
    // So: distance_along_front = zlinear * zFar
    // But we need distance_along_ray = distance_along_front / dot(ray_direction, cameraFront)
    let distance_along_front = zlinear * camera.cameraFar;
    let distance_along_ray = distance_along_front / dot(ray_direction, camera.cameraFront.xyz);
    
    // Calculate final world position
    return camera.cameraPosition.xyz + ray_direction * distance_along_ray;
}

// Get view space direction from clip space position
fn get_view_dir(clip_pos: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Extract FOV and aspect ratio from projection matrix
    let fov = atan(1.0 / camera.projectionMatrix[1][1]);
    let aspect = camera.projectionMatrix[1][1] / camera.projectionMatrix[0][0];
    
    // Reconstruct view space direction
    var view_dir = vec3<f32>(
        clip_pos.x * tan(fov) * aspect,
        clip_pos.y * tan(fov),
        -1.0
    );
    
    return normalize(view_dir);
}

// Transform view space direction to world space
fn get_world_dir(view_dir: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Inverse rotation = transpose of upper 3x3 view matrix
    let rotation = transpose(mat3x3<f32>(
        camera.viewMatrix[0].xyz,
        camera.viewMatrix[1].xyz,
        camera.viewMatrix[2].xyz
    ));
    
    return rotation * view_dir;
}

// Convert 3D direction to equirectangular UV coordinates
fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
    let theta = atan2(dir.x, dir.z); // [-PI, PI]
    let phi = acos(clamp(dir.y, -1.0, 1.0)); // [0, PI]
    let u = (theta + PI) / TWO_PI; // [0, 1]
    let v = phi / PI; // [0, 1]
    return vec2<f32>(u, v);
}

// Normal encoding and decoding utilities
// Level 1: No dependencies

// Encode normal vector to vec4 (simple method)
fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

// Decode normal vector from encoded format
fn decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32> {
    return encodedNormal * 2.0 - 1.0;
}


fn decodeGBuffer(uv: vec2<f32>) -> GBuffer {
    var g: GBuffer;
    
    // Get linear depth and world position
    let zlinear = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    g.zlinear = zlinear;
    g.worldPos = getWorldCoords(uv, zlinear, camera);
    
    let normalRoughnessData = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0);
    let encodedNormal = normalRoughnessData.xy;
    g.normal = octahedral01ToNormal(encodedNormal);
    g.roughness = max(normalRoughnessData.z, 0.045);
    
    // Get albedo and metallic
    let albedo = textureSampleLevel(gAlbedo, samplerGBuffer, uv, 0.0);
    g.metallic = albedo.a;
    
    g.albedo = albedo.rgb;
    
    // Get self illumination
    g.emissive = normalRoughnessData.a;
    g.selfIllum = g.albedo * g.emissive;
    
    // Default specular for dielectrics is 0.04
    g.specularColor = mix(vec3<f32>(0.04), g.albedo, g.metallic);
    
    // View and reflection directions
    let incident_dir = normalize(g.worldPos - camera.cameraPosition.xyz);
    g.reflectedDir = normalize(reflect(incident_dir, g.normal));
    g.viewDir = -incident_dir;
    
    return g;
}
// ─── Reflection / irradiance probes, per pixel ───────────────────────────────
//
// ProbeManager uploads the probes near the camera (ProbeSet) and keeps every probe's
// GGX-prefiltered cubemap in one cube array. Each pixel blends the probes whose box
// contains it, by a weight that fades `fade` metres either side of the box faces — so
// boxes that tile (auto-placement) cross-fade at their shared face and sum to 1 there.
// Where the weights add up to less than 1, the global environment fills the rest.
//
// Includers declare, with their own group/binding:
//   var<storage, read> probeSet: ProbeSet;
// Specular (cube array) helpers: common/probes_specular.wgsl.

// ─── Parallax Corrected Cubemap (PCC) ────────────────────────────────────────
//
// Standard cubemaps assume the environment is infinitely far away.
// PCC corrects the reflection/normal vector so it "points" to the right
// position inside the probe's AABB, aligning reflections with real room geometry.
//
// Algorithm (Lagarde & de Rousiers, "Physically Based Rendering in Call of Duty",
//            also used extensively in Uncharted 4 interiors):
//
//   1. For each axis, compute the intersection distance with the near and far
//      slab of the AABB: rbmax = (boxMax - P) / R,  rbmin = (boxMin - P) / R
//   2. Per-component, pick the exit slab:
//         if R > 0  →  exit is boxMax slab  (rbmax)
//         if R < 0  →  exit is boxMin slab  (rbmin)
//   3. The actual exit distance is min(rbminmax.xyz)
//   4. posonbox = P + R * fa   ← world-space hit point on the AABB surface
//   5. Return (posonbox - probePos) — direction from probe capture point to
//      that surface hit.  The cubemap was shot from probePos, so this direction
//      indexes the correct texel.
//
// worldPos  – fragment world-space position
// R         – ray direction to correct (should be normalised)
// probePos  – world-space capture/centre position of the probe
// boxMin    – world-space AABB minimum
// boxMax    – world-space AABB maximum
//
// Returns an unnormalised direction (GPU normalises cube samples implicitly).
fn parallaxCorrectDir(
    worldPos : vec3<f32>,
    R        : vec3<f32>,
    probePos : vec3<f32>,
    boxMin   : vec3<f32>,
    boxMax   : vec3<f32>,
) -> vec3<f32> {
    let rbmax    = (boxMax - worldPos) / R;
    let rbmin    = (boxMin - worldPos) / R;
    // Per-component: pick the exit-slab distance based on ray sign
    let rbminmax = select(rbmin, rbmax, R > vec3<f32>(0.0));
    // Smallest exit distance across all three axes
    let fa       = min(min(rbminmax.x, rbminmax.y), rbminmax.z);
    // World-space hit point → direction from probe capture origin
    let posonbox = worldPos + R * fa;
    return posonbox - probePos;
}


struct ProbeGPU {
    pos:    vec4<f32>,             // xyz = capture point, w = 1 outdoor / 2 indoor (PCC)
    boxMin: vec4<f32>,             // xyz = influence box min
    boxMax: vec4<f32>,             // xyz = influence box max, w = cube index (-1 = no env yet)
    fade:   vec4<f32>,             // xyz = cross-fade distance per axis (m)
    sh:     array<vec4<f32>, 9>,   // L2 irradiance (cosine lobe pre-convolved)
}

struct ProbeSet {
    count:       u32,
    hasGlobalSH: u32,
    envMaxMip:   f32,
    ambientScale: f32,                  // ambient boosts (global × diffuse), for forward shading
    globalSH:    array<vec4<f32>, 9>,   // sky / HDR environment irradiance
    gridMin:     vec2<f32>,             // XZ origin of the probe grid
    gridInvCell: vec2<f32>,             // cells per metre
    cellMask:    array<u32, 1024>,      // PROBE_GRID_DIM², bit i = probes[i] overlaps the cell
    probes:      array<ProbeGPU>,
}

const PROBE_GRID_DIM = 32;

// Bitmask of the probes that may weigh at `worldPos` (ProbeManager.buildGrid). Loop it with
//   while (mask != 0u) { let i = firstTrailingBit(mask); mask &= mask - 1u; … }
fn probeMask(worldPos: vec3<f32>) -> u32 {
    let cell = vec2<i32>(floor((worldPos.xz - probeSet.gridMin) * probeSet.gridInvCell));
    if (any(cell < vec2<i32>(0)) || any(cell >= vec2<i32>(PROBE_GRID_DIM))) { return 0u; }
    return probeSet.cellMask[cell.y * PROBE_GRID_DIM + cell.x];
}

fn evalSHProbe(c: array<vec4<f32>, 9>, N: vec3<f32>) -> vec3<f32> {
    let x = N.x; let y = N.y; let z = N.z;
    var r = c[0].rgb * 0.282095;
    r += c[1].rgb * (0.488603 * y);
    r += c[2].rgb * (0.488603 * z);
    r += c[3].rgb * (0.488603 * x);
    r += c[4].rgb * (1.092548 * x * y);
    r += c[5].rgb * (1.092548 * y * z);
    r += c[6].rgb * (0.315392 * (3.0 * z * z - 1.0));
    r += c[7].rgb * (1.092548 * x * z);
    r += c[8].rgb * (0.546274 * (x * x - y * y));
    return max(r, vec3<f32>(0.0));
}

// Per axis: 0 beyond box + fade, 0.5 on the box face, 1 once `fade` inside it. Separate
// fades let grid cells cross-fade wide horizontally while staying sharp at floor level.
// Takes the index, not a ProbeGPU: copying the struct out of the storage buffer loads all
// 13 vec4 (SH included) per probe per pixel, and this runs for every active probe.
fn probeWeight(i: u32, worldPos: vec3<f32>) -> f32 {
    let inside = min(worldPos - probeSet.probes[i].boxMin.xyz, probeSet.probes[i].boxMax.xyz - worldPos);
    let fade = max(probeSet.probes[i].fade.xyz, vec3<f32>(1e-3));
    if (any(inside <= -fade)) { return 0.0; }
    let w = smoothstep(-fade, fade, inside);
    return min(w.x, min(w.y, w.z));
}

struct ProbeIrradiance {
    irradiance: vec3<f32>,
    coverage:   f32,   // how much of it came from probes (0–1)
}

fn probeIrradiance(worldPos: vec3<f32>, N: vec3<f32>) -> ProbeIrradiance {
    var acc  = vec3<f32>(0.0);
    var wsum = 0.0;
    var mask = probeMask(worldPos);
    while (mask != 0u) {
        let i = firstTrailingBit(mask);
        mask &= mask - 1u;
        let w = probeWeight(i, worldPos);
        if (w > 0.0) {
            acc  += evalSHProbe(probeSet.probes[i].sh, N) * w;
            wsum += w;
        }
    }
    var out: ProbeIrradiance;
    out.coverage = min(wsum, 1.0);
    out.irradiance = acc / max(wsum, 1.0);
    if (probeSet.hasGlobalSH != 0u) {
        out.irradiance += evalSHProbe(probeSet.globalSH, N) * (1.0 - out.coverage);
        out.coverage = 1.0;
    }
    return out;
}

// ─── Realtime GI: shared parameters, probe-volume layout ──────────────────────
//
// Probe volumes (DDGI-style, RealtimeGI.ts / GIProbeVolumes.ts), listed in giVolumes, finest
// first: local volumes (gi_volume components: interiors), then either one volume fitted to the
// level or camera-centred cascades (spacing doubling). Each volume has its own dims and spacing
// and owns probes [dims.w, dims.w + dims.x·y·z) of the global probe arrays and atlases.
// Storage is toroidal: the probe at absolute grid coordinate `coord` lives in slot
// posMod(coord, dims), so when a cascade scrolls only the slots that wrap change meaning. Each
// slot remembers which coordinate it holds (giProbeState); a probe whose stored coordinate
// differs from the expected one is treated as missing until it is traced again. Each frame
// traces one batch of one volume (updateInfo).
//
// Per probe, in two atlases (one tile per probe, row-major by global probe index, 1-texel
// octahedral border for bilinear):
//   irradiance  GI_IRR_RES² rgba16float  rgb = irradiance E (not divided by π)
//   visibility  GI_VIS_RES² rgba16float  rg  = mean distance, mean squared distance (Chebyshev)
//
// Includers declare, with their own group/binding:
//   var<uniform> giParams: GIParams;
// Volume layout helpers (gi/common/gi_volumes) also need giVolumes, probe-state helpers
// (gi/common/gi_state) giProbeState, sampling (gi/common/gi_sampling) the atlases and a
// linear sampler.

struct GIParams {
    frameInfo:   vec4<u32>,     // x = frame index, y = light count, z = debug view, w = flags (GI_FLAG_*)
    gridInfo:    vec4<u32>,     // x = atlas tiles per row, y = volume count, z = rays per probe, w = volume traced this frame
    updateInfo:  vec4<u32>,     // x = first slot traced this frame, y = slots traced
    rayRotation: mat4x4<f32>,   // random rotation of this frame's ray set
    sunDir:      vec4<f32>,     // xyz = toward the sun, w = 1 if there is one
    sunColor:    vec4<f32>,     // rgb = colour × intensity
    tuning:      vec4<f32>,     // x = hysteresis (this frame's volume), y = sky intensity, z = GI intensity, w = compare split (uv.x)
    tuning2:     vec4<f32>,     // x = normal bias, y = view bias (× spacing), z = ray length, w = bounce strength
    atlasSize:   vec4<f32>,     // xy = irradiance atlas texels, zw = visibility atlas texels
    ambient:     vec4<f32>,     // x = global ambient boost, y = diffuse boost (ambient.fs probe path)
    lightGrid:   array<vec4<f32>, 4>,  // per light-grid cascade: xyz = world min corner, w = cell size (gi_light_grid)
    cache:       vec4<f32>,     // x = cache cell size at LOD 0, y = LOD distance, z = min update blend, w = gather ray length
    cacheInfo:   vec4<u32>,     // x = cache capacity (power of 2), y = cells updated per frame, z = light samples per shade
    cameraPos:   vec4<f32>,     // xyz = camera position (cache LOD)
}

struct GIVolume {
    origin:  vec4<i32>,   // xyz = absolute grid coordinate of the min probe
    dims:    vec4<u32>,   // xyz = probes per axis, w = first global probe index
    spacing: vec4<f32>,   // x = metres between probes, y = fade width (cells) at the edges, z = kind (0 local, 1 level, 2 cascade)
}

struct GILight {
    posRadius:    vec4<f32>,  // xyz = position, w = outer radius
    colorFalloff: vec4<f32>,  // rgb = colour × intensity, w = start falloff radius
    dirCos:       vec4<f32>,  // xyz = spot forward, w = cos(half angle); w < -1 for point lights
}

const GI_IRR_RES: u32 = 6u;
const GI_VIS_RES: u32 = 14u;
/** A probe whose (smoothed) share of back-face hits exceeds this is inside geometry: skipped. */
const GI_INACTIVE_RATIO: f32 = 0.25;
const GI_FLAG_MULTIBOUNCE: u32 = 1u;
const GI_FLAG_COMPARE: u32 = 2u;
/** Probe rays read the world radiance cache (gi/common/gi_cache) instead of shading every hit. */
const GI_FLAG_CACHE: u32 = 4u;
/** Per-pixel final gather (gi_gather.cs) replaces the probe lookup in the resolve. */
const GI_FLAG_GATHER: u32 = 8u;
const GI_PI: f32 = 3.14159265359;
const GI_INV_PI: f32 = 0.31830988618;
/** No triangle / light / cache slot. */
const GI_MISS: u32 = 0xffffffffu;
/** Ray distance written for misses (sky). */
const GI_MISS_DISTANCE: f32 = 1.0e4;

// ── Octahedral mapping ([-1,1]² ↔ unit sphere) ───────────────────────────────

fn giSignNotZero(v: vec2<f32>) -> vec2<f32> {
    return select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
}

fn giOctEncode(n: vec3<f32>) -> vec2<f32> {
    let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    return select(p, (1.0 - abs(p.yx)) * giSignNotZero(p), n.z < 0.0);
}

fn giOctDecode(e: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
    if (n.z < 0.0) {
        n = vec3<f32>((1.0 - abs(n.yx)) * giSignNotZero(n.xy), n.z);
    }
    return normalize(n);
}

// ── Random numbers / ray set ─────────────────────────────────────────────────

fn giHash(x: u32) -> u32 {
    var h = x;
    h ^= h >> 16u; h *= 0x7feb352du;
    h ^= h >> 15u; h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}

fn giRand(state: ptr<function, u32>) -> f32 {
    *state = giHash(*state);
    return f32(*state >> 8u) * (1.0 / 16777216.0);
}

fn giSphericalFibonacci(i: u32, n: u32) -> vec3<f32> {
    let phi = 2.0 * GI_PI * fract(f32(i) * 0.6180339887498949);
    let cosTheta = 1.0 - (2.0 * f32(i) + 1.0) / f32(n);
    let sinTheta = sqrt(saturate(1.0 - cosTheta * cosTheta));
    return vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}

/** Direction of probe ray `i` this frame (all probes share the rotated set). */
fn giRayDirection(i: u32) -> vec3<f32> {
    let d = giSphericalFibonacci(i, giParams.gridInfo.z);
    return normalize((giParams.rayRotation * vec4<f32>(d, 0.0)).xyz);
}


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo:        texture_2d<f32>;
@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var gAO:               texture_2d<f32>;
@group(2) @binding(1) var samplerAO:         sampler;
#ifndef GI_DIRECT
@group(2) @binding(2) var<uniform> giParams: GIParams;
#endif
@group(2) @binding(3) var brdfLUT:           texture_2d<f32>;
@group(2) @binding(4) var<storage, read> probeSet: ProbeSet;
@group(2) @binding(5) var giResolve:         texture_2d<f32>;

#ifdef GI_DIRECT
@group(3) @binding(0) var<uniform> giParams: GIParams;
@group(3) @binding(1) var<storage, read> giProbeState: array<vec4<f32>>;
@group(3) @binding(2) var<storage, read> giVolumes: array<GIVolume>;
@group(3) @binding(3) var giIrradianceAtlas: texture_2d<f32>;
@group(3) @binding(4) var giVisibilityAtlas: texture_2d<f32>;
@group(3) @binding(5) var giSampler: sampler;
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

#endif

/** ambient.fs irradiance: baked probes, sky SH, hemisphere placeholder — × ambient boosts. */
fn bakedIrradiance(g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let probes = probeIrradiance(g.worldPos, N);
    var irradiance = probes.irradiance;
    if (probes.coverage < 1.0) {
        let hemi = N.y * 0.5 + 0.5;
        irradiance += mix(vec3<f32>(0.10, 0.07, 0.04), vec3<f32>(0.38, 0.50, 0.65), hemi)
                    * (1.0 - probes.coverage);
    }
    return irradiance * giParams.ambient.x * giParams.ambient.y;
}

/**
 * Joint bilateral upsample of the GI resolve: the 4 low-res texels around the pixel, bilinear
 * weights × depth and normal similarity of the full-res pixel each was evaluated at.
 */
fn upsampleGI(fragCoord: vec2<f32>, g: GBuffer) -> vec3<f32> {
    let lowSize = vec2<f32>(textureDimensions(giResolve));
    let fullSize = vec2<f32>(textureDimensions(gLinearDepth));
    let scale = fullSize / lowSize;
    let p = fragCoord / scale - 0.5;
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    let N = normalize(g.normal);
    let maxTexel = vec2<i32>(lowSize) - 1;

    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 4; i++) {
        let off = vec2<i32>(i & 1, i >> 1);
        let t = clamp(base + off, vec2<i32>(0), maxTexel);
        let src = vec2<i32>(floor(vec2<f32>(t) * scale));
        let z = textureLoad(gLinearDepth, src, 0).x;
        let n = octahedral01ToNormal(textureLoad(gNormals, src, 0).xy);
        let bil = mix(1.0 - f.x, f.x, f32(off.x)) * mix(1.0 - f.y, f.y, f32(off.y));
        let wz = 1.0 / (1.0 + abs(z - g.zlinear) / max(g.zlinear, 1e-4) * 64.0);
        let wn = pow(saturate(dot(n, N)), 8.0);
        let w = max(bil * wz * wn, 1e-5 * bil);
        sum += textureLoad(giResolve, t, 0).rgb * w;
        wsum += w;
    }
    return sum / max(wsum, 1e-6);
}

@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let ao = textureSample(gAO, samplerAO, uv).b;
    if (g.zlinear > 0.999) { discard; }

    let N = normalize(g.normal);
    let compare = (giParams.frameInfo.w & GI_FLAG_COMPARE) != 0u;
    let split = giParams.tuning.w;

    var irradiance: vec3<f32>;
    if (compare && uv.x < split) {
        irradiance = bakedIrradiance(g);
    } else {
#ifdef GI_DIRECT
        let gi = giSampleIrradiance(g.worldPos, N, normalize(g.viewDir));
        irradiance = gi.rgb * giParams.tuning.z + bakedIrradiance(g) * (1.0 - gi.a);
#else
        irradiance = upsampleGI(fragCoord.xy, g);
#endif
    }

    // kD exactly as ambient.fs (LUT directional albedo + Kulla-Conty multiple scattering).
    let NdV = clamp(dot(N, normalize(g.viewDir)), 0.001, 1.0);
    let brdf = textureSampleLevel(brdfLUT, samplerAO, vec2<f32>(NdV, 1.0 - clamp(g.roughness, 0.0, 1.0)), 0.0).rg;
    let E    = g.specularColor * brdf.x + brdf.y;
    let Ems  = 1.0 - (brdf.x + brdf.y);
    let Favg = g.specularColor + (1.0 - g.specularColor) / 21.0;
    let Fms  = E * Favg * Ems / max(1.0 - Favg * Ems, vec3<f32>(0.001));
    let kD   = (1.0 - E - Fms) * (1.0 - g.metallic);

    var color = kD * Diffuse(g.albedo) * irradiance * ao + g.selfIllum;
    if (compare && abs(fragCoord.x - split * camera.screenSize.x) < 1.0) {
        color = vec3<f32>(2.0);
    }
    return vec4<f32>(color, 1.0);
}
