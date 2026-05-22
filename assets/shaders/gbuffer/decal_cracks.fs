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

// ── Bind groups (mirrors decal_multiface layout) ─────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1): no textures needed — fully procedural.
// We keep the sampler slot so the pipeline layout matches partial_gbuffer decals.
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
// factors usage:
//   baseColorFactor.rgb = crack glow color  (e.g. 0, 0.4, 1 for mana blue)
//   baseColorFactor.a   = overall opacity
//   emissiveFactor      = glow intensity stored in GBuffer emissive channel (0-1, multiplied by albedo in lighting)
//   roughnessFactor     = large crack scale  (default 1 = 3.0 local-space units)
//   metallicFactor      = small crack scale  (default 1 = 7.0 local-space units)
//   uvXScale            = crack thickness    (default 1 = 0.06)

@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@group(3) @binding(0) var gBufferAlbedo:  texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(3) @binding(3) var samplerGBuffer: sampler;

// ── Output (partial_gbuffer: albedo + normal, no linearDepth) ────────────────
struct CrackDecalOutput {
    @location(0) albedo: vec4<f32>,   // RGB = albedo linear, A = metallic
    @location(1) normal: vec4<f32>,   // RG  = octahedral N,  B = roughness, A = emissive
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x:   vec3<f32>,
    @location(2) decal_axis_z:   vec3<f32>,
    @location(3) decal_axis_y:   vec3<f32>,
}

// ── Hash functions ────────────────────────────────────────────────────────────
fn hash31(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
    var p3 = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 19.19);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// ── 3D Voronoi edge distance ──────────────────────────────────────────────────
// Returns min_dist2 - min_dist1: distance to the nearest Voronoi cell border.
// Because the input is 3D world-space position, this is naturally continuous
// across any corner or curved surface — no UV seams possible.
fn voronoi3d_edge(p: vec3<f32>) -> f32 {
    let cell = floor(p);
    let f    = fract(p);

    var d1 = 9.0;
    var d2 = 9.0;

    for (var k = -1; k <= 1; k++) {
        for (var j = -1; j <= 1; j++) {
            for (var i = -1; i <= 1; i++) {
                let neighbor = vec3<f32>(f32(i), f32(j), f32(k));
                let point    = hash33(cell + neighbor) + neighbor;
                let d        = distance(f, point);
                if (d < d1) {
                    d2 = d1;
                    d1 = d;
                } else if (d < d2) {
                    d2 = d;
                }
            }
        }
    }

    return d2 - d1;
}

// ── Two-frequency crack pattern ───────────────────────────────────────────────
// Domain warp: distort the position with smooth sin-based noise before Voronoi.
// This turns the geometrically-perfect cell boundaries into organic, jagged cracks.
fn domain_warp(p: vec3<f32>, strength: f32) -> vec3<f32> {
    return p + vec3<f32>(
        sin(p.y * 6.2832 + p.z * 3.1416) * strength,
        sin(p.z * 6.2832 + p.x * 3.1416) * strength,
        sin(p.x * 6.2832 + p.y * 3.1416) * strength
    );
}

fn crack_pattern(p: vec3<f32>, large_scale: f32, small_scale: f32) -> f32 {
    // Warp proportionally to scale so the distortion is always crack-width relative.
    let warp_strength = 0.18 / large_scale;
    let p_warped = domain_warp(p, warp_strength);

    let large  = voronoi3d_edge(p_warped * large_scale);
    // Apply a second warp at small scale for the micro fractures — different phase.
    let p_warped2 = domain_warp(p + vec3<f32>(7.3, 2.1, 5.7), warp_strength * 0.6);
    let small_ = voronoi3d_edge(p_warped2 * small_scale);

    // min() instead of weighted blend: the result reaches 0 wherever EITHER scale
    // has a crack, giving a dense interlocking network instead of a mushy average.
    // Multiply small_ by 1.4 so large cracks stay dominant when both are present.
    return min(large, small_ * 1.4);
}

// ── Main ──────────────────────────────────────────────────────────────────────
@fragment
fn fs(input: DecalVertexOutput) -> CrackDecalOutput {
    // ── Screen UV + depth reconstruction ─────────────────────────────────────
    let screen_uv = input.position.xy / camera.screenSize;
    let depth     = textureSampleLevel(gLinearDepth, samplerGBuffer, screen_uv, 0.0).x;
    let world_pos = getWorldCoords(screen_uv, depth, camera);

    // ── Decal box membership ──────────────────────────────────────────────────
    let to_wpos    = world_pos - input.decal_top_left;
    let ax_len_x   = length(input.decal_axis_x);
    let ax_len_z   = length(input.decal_axis_z);
    let ax_len_y   = length(input.decal_axis_y);
    let amount_x   = dot(to_wpos, input.decal_axis_x) / (ax_len_x * ax_len_x);
    let amount_z   = dot(to_wpos, input.decal_axis_z) / (ax_len_z * ax_len_z);
    let amount_y   = dot(to_wpos, input.decal_axis_y) / (ax_len_y * ax_len_y);

    if (amount_x < 0.0 || amount_x > 1.0 ||
        amount_z < 0.0 || amount_z > 1.0 ||
        amount_y < 0.0 || amount_y > 1.0) {
        discard;
    }

    // ── Edge feathering ───────────────────────────────────────────────────────
    // Soft fade in 5% from each box face so the decal boundary is invisible.
    let feather_k = 0.05;
    let fade_x = smoothstep(0.0, feather_k, amount_x) * smoothstep(1.0, 1.0 - feather_k, amount_x);
    let fade_z = smoothstep(0.0, feather_k, amount_z) * smoothstep(1.0, 1.0 - feather_k, amount_z);
    let fade_y = smoothstep(0.0, feather_k, amount_y) * smoothstep(1.0, 1.0 - feather_k, amount_y);
    let edge_fade = fade_x * fade_z * fade_y;

    // ── Crack pattern in 3D local decal space ─────────────────────────────────
    // Using local_pos (normalised 0..1 box coords) means the pattern scales
    // with the decal box and is independent of world scale.
    let local_pos = vec3<f32>(amount_x, amount_y, amount_z);

    // Scale factors driven by material: roughnessFactor → large cracks, metallicFactor → small.
    // Defaults (both 1) give large_scale=3, small_scale=7 which looks good at 1-2m boxes.
    let large_scale = factors.roughnessFactor * 3.0;
    let small_scale = factors.metallicFactor  * 7.0;

    let crack_raw  = crack_pattern(local_pos, large_scale, small_scale);

    // ── Glow layers ───────────────────────────────────────────────────────────
    // thickness is controlled by uvXScale (default 1 → 0.06).
    let thickness  = factors.uvXScale * 0.06;

    // Core: the bright white-hot centre of the crack.
    let core       = 1.0 - smoothstep(0.0, thickness * 0.25, crack_raw);
    // Inner glow: blue/color bloom just around the core.
    let inner_glow = 1.0 - smoothstep(0.0, thickness,        crack_raw);
    // Outer halo: diffuse scatter that spills over the surface.
    let outer_halo = 1.0 - smoothstep(0.0, thickness * 3.5,  crack_raw);

    let glow_color = factors.baseColorFactor.rgb;
    let core_color = mix(glow_color, vec3<f32>(0.85, 0.95, 1.0), 0.5); // desaturate toward white

    // ── Alpha ─────────────────────────────────────────────────────────────────
    let crack_alpha = outer_halo * edge_fade * factors.baseColorFactor.a;
    if (crack_alpha < 0.005) { discard; }

    // ── Read current GBuffer values ───────────────────────────────────────────
    let orig_albedo  = textureSampleLevel(gBufferAlbedo,  samplerGBuffer, screen_uv, 0.0);
    let orig_normals = textureSampleLevel(gBufferNormals, samplerGBuffer, screen_uv, 0.0);

    // ── Albedo: blend toward glow_color at the crack ──────────────────────────
    // The lighting pass computes: selfIllum = albedo * emissive_scalar.
    // To get mana-blue emission we MUST write the glow color into albedo where
    // the crack is — otherwise the stone's reddish albedo tints the emission.
    //
    // Outer halo: subtle dark scorch, albedo mostly unchanged.
    let scorch_amount = outer_halo * crack_alpha * 0.35;
    let scorched_base = orig_albedo.rgb * (1.0 - scorch_amount);
    // Inner zone → glow_color, core → core_color.
    let inner_strength = inner_glow * crack_alpha;
    let core_strength  = core       * crack_alpha;
    var out_albedo     = mix(scorched_base, glow_color, inner_strength);
    out_albedo         = mix(out_albedo,    core_color, core_strength);

    // ── Emissive scalar ───────────────────────────────────────────────────────
    // Layer the scalar: outer halo dim, inner bright, core max.
    // emissiveFactor controls overall intensity — use 0.5-1.0 range here since
    // the GBuffer emissive channel is [0,1] and the lighting pass uses it as a
    // direct scalar on albedo (already set to glow_color above).
    let emissive_scalar = outer_halo * factors.emissiveFactor * 0.3
                        + inner_glow * factors.emissiveFactor * 0.7
                        + core       * factors.emissiveFactor;
    let out_emissive = saturate(mix(orig_normals.a, emissive_scalar, crack_alpha));

    var output: CrackDecalOutput;
    output.albedo = vec4<f32>(out_albedo, orig_albedo.a);
    output.normal = vec4<f32>(orig_normals.xy, orig_normals.z, out_emissive);
    return output;
}
