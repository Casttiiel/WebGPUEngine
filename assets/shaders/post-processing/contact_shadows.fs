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

// ─── Contact Shadow Parameters ───────────────────────────────────────────────
// Struct matches TypeScript side: 8 floats = 32 bytes
// lightDir (vec3) + intensity (f32) = first 16 bytes (vec3 padded to 16 via WGSL rules)
// stepLength + maxDistance + thickness + enabled = last 16 bytes
struct ContactShadowParams {
    lightDir:    vec3<f32>,  // world-space direction FROM surface TOWARD light
    intensity:   f32,        // shadow strength [0, 1]
    stepLength:  f32,        // world-space ray step size (meters)
    maxDistance: f32,        // max ray travel distance (meters)
    thickness:   f32,        // linearDepth tolerance for occlusion detection
    enabled:     f32,        // 0 = disabled
}

// ─── Bind Groups ─────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// GBuffer — standard layout (group 1)
@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// Contact shadow params (group 2) — outputs shadow factor [0,1], not accLight
@group(2) @binding(0) var<uniform> params: ContactShadowParams;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Project a world-space position to screen UV [0,1].
// Returns vec3: xy = UV, z = clip.w (≤ 0 means behind camera — treat as invalid).
fn worldToUVW(worldPos: vec3<f32>) -> vec3<f32> {
    let clip = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(worldPos, 1.0));
    // Guard: behind camera → return sentinel so caller can skip this step
    if (clip.w <= 0.0) {
        return vec3<f32>(0.0, 0.0, -1.0);
    }
    let ndc = clip.xy / clip.w;
    // WebGPU NDC: x∈[-1,1]→[0,1], y∈[-1,1] (Y-up)→[1,0] (Y-down in UV)
    return vec3<f32>(ndc.x * 0.5 + 0.5, -ndc.y * 0.5 + 0.5, clip.w);
}

// Compute the linearDepth convention used by the GBuffer for an arbitrary world pos.
// GBuffer stores: dot(worldPos - cameraPos, cameraFront) / zFar
fn worldToLinearDepth(pos: vec3<f32>) -> f32 {
    let diff = pos - camera.cameraPosition.xyz;
    return dot(diff, camera.cameraFront.xyz) / camera.cameraFar;
}

// Interleaved Gradient Noise — low-discrepancy per-pixel noise in [0, 1).
// Breaks up banding from fixed-step ray marching without repeating tile patterns.
fn interleavedGradientNoise(coord: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(coord, vec2<f32>(0.06711056, 0.00583715))));
}

// ─── Fragment Entry ───────────────────────────────────────────────────────────
@fragment
fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / camera.screenSize;

    // Early-out: disabled — factor 1.0 means no attenuation
    if (params.enabled < 0.5) {
        return vec4<f32>(1.0);
    }

    // Decode GBuffer — gives worldPos, normal, zlinear, etc.
    let g = decodeGBuffer(uv);

    // Early-out: sky / far plane
    if (g.zlinear >= 0.9999) {
        return vec4<f32>(1.0);
    }

    // Early-out: surface facing away from the light (backlit → no contact shadow)
    let NdL = saturate(dot(g.normal, params.lightDir));
    if (NdL < 0.01) {
        return vec4<f32>(1.0);
    }

    // ── Screen-space-aware step count ────────────────────────────────────────
    // World-space steps produce banding near the camera because a fixed step
    // covers very different numbers of pixels depending on depth.  Project the
    // full ray extent to screen space and derive numSteps so each step covers
    // roughly a constant number of pixels — dense near the camera, sparse far.
    var numSteps: i32 = 16; // safe fallback
    let startClip = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(g.worldPos, 1.0));
    let endWorld  = g.worldPos + params.lightDir * params.maxDistance;
    let endClip   = camera.projectionMatrix * (camera.viewMatrix * vec4<f32>(endWorld, 1.0));
    if (startClip.w > 0.0 && endClip.w > 0.0) {
        let startNDC  = startClip.xy / startClip.w;
        let endNDC    = endClip.xy   / endClip.w;
        // Convert NDC distance to pixels (account for UV-space scale)
        let startUV   = vec2<f32>(startNDC.x * 0.5 + 0.5, -startNDC.y * 0.5 + 0.5);
        let endUV     = vec2<f32>(endNDC.x   * 0.5 + 0.5, -endNDC.y   * 0.5 + 0.5);
        let screenPx  = length((endUV - startUV) * camera.screenSize);
        // ~1 step every 3 pixels, clamped to a sensible range
        numSteps = clamp(i32(screenPx / 3.0), 4, 32);
    }

    // ── Adaptive step size derived from maxDistance ──────────────────────────
    // Using a fixed params.stepLength against a dynamic numSteps means the ray
    // covers numSteps * stepLength which may be far less than maxDistance (deficit)
    // or exceed it (handled by the old t > maxDistance guard, but the near-camera
    // deficit case was silently under-sampling the shadow region).
    // Deriving actualStep from maxDistance guarantees the ray always spans exactly
    // [0, maxDistance] regardless of how many steps the screen-space heuristic chose.
    let actualStep = params.maxDistance / f32(numSteps);

    // ── Self-shadowing bias ───────────────────────────────────────────────────
    // Per-pixel jitter (IGN + golden-ratio temporal shift) randomises the starting
    // offset of each ray so adjacent pixels and adjacent frames never share the same
    // discrete sample pattern.  Breaks banding stripes and lets TAA accumulate a
    // clean result over multiple frames.
    let jitter = fract(interleavedGradientNoise(fragCoord.xy) + camera.frameIndex * 0.6180339887);
    // Offset the first sample into [0, actualStep) so the ray starts slightly ahead
    // of the surface.  The depth-proportional term prevents acne at large view depths.
    let startBias = actualStep * jitter + g.zlinear * camera.cameraFar * 0.001;

    // ── World-space ray march toward light ───────────────────────────────────
    var shadow: f32 = 0.0;

    for (var i: i32 = 1; i <= numSteps; i++) {
        let t = startBias + f32(i) * actualStep;
        // t is bounded by startBias + numSteps * actualStep = jitter*actualStep + maxDistance
        // which is at most maxDistance + actualStep — no break needed.

        let rayPos = g.worldPos + params.lightDir * t;
        let uvw    = worldToUVW(rayPos);

        // Behind camera: skip this step, continue ray (don't abort entirely)
        if (uvw.z <= 0.0) { continue; }

        let rayUV = uvw.xy;

        // Outside screen: continue — the ray may re-enter near screen edges
        if (rayUV.x < 0.0 || rayUV.x > 1.0 || rayUV.y < 0.0 || rayUV.y > 1.0) {
            continue;
        }

        let sceneZ = textureSampleLevel(gLinearDepth, samplerGBuffer, rayUV, 0.0).x;
        let rayZ   = worldToLinearDepth(rayPos);

        // Ray is behind geometry and within the thickness band → occluded
        let delta = rayZ - sceneZ;
        if (delta > 0.0 && delta < params.thickness) {
            let fade = 1.0 - t / params.maxDistance;
            // Contact shadow is binary (occluder present or not) — do NOT scale by
            // NdL here.  Grazing surfaces (low NdL) can still be fully occluded;
            // surfaces facing away are already excluded by the early-out above.
            shadow = params.intensity * max(0.0, fade);
            break;
        }
    }

    // Output shadow factor: 1.0 = fully lit, 0.0 = fully in shadow
    let shadowFactor = 1.0 - shadow;
    return vec4<f32>(shadowFactor, shadowFactor, shadowFactor, 1.0);
}

