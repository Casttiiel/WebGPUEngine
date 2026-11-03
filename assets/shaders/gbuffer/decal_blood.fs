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

// Salpicadura de sangre procedural (BloodFX). Cada mancha es distinta (azar = su posición):
// un charco de metaballs, gotas lanzadas en abanico hacia +X del decal (la dirección del
// golpe), alargadas en su dirección, y salpicaduras sueltas. Del grosor salen el color (fina
// = roja, gruesa = casi negra), el relieve del borde y lo mojada que está (rugosidad).
//
// La edad va en la altura del decal (eje Y): altura = 0.5 + 0.5·edad (m), edad 0 (recién
// caída) → 1 (seca y desaparecida). Así BloodFX la envejece sin uniforms propios.

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>,     // RG: normal octaédrica, B: roughness, A: (se conserva)
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(5) var samplerState: sampler;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var gBufferAlbedo: texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(3) @binding(3) var samplerState2: sampler;

/// Espesor de la película de sangre (m) para el relieve: exagerado para que se vea desde lejos.
const FILM_HEIGHT: f32 = 0.006;

fn hash11(n: f32) -> f32 {
    return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

fn hash21(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    return fract((q.x + 45.32) * (q.y + 45.32) * 33.7 + dot(q, q + 45.32));
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

/// Suma de metaballs (1 en el borde, más dentro). `p` en [-1, 1], +X = hacia donde salió.
fn splatField(p: vec2<f32>, seed: f32) -> f32 {
    var f = 0.0;
    // Charco principal: algo retrasado respecto al centro (lo más grueso cae primero).
    for (var i = 0; i < 6; i++) {
        let s = seed + f32(i) * 7.31;
        let c = vec2<f32>(mix(-0.45, 0.1, hash11(s)), (hash11(s + 1.0) - 0.5) * 0.5);
        let r = mix(0.1, 0.22, hash11(s + 2.0));
        let d = p - c;
        f += r * r / max(dot(d, d), 1e-5);
    }
    // Gotas lanzadas en abanico: más lejos, más pequeñas y más alargadas.
    for (var i = 0; i < 11; i++) {
        let s = seed + 100.0 + f32(i) * 5.17;
        let a = (hash11(s) - 0.5) * 1.3;
        let dir = vec2<f32>(cos(a), sin(a));
        let k = hash11(s + 1.0);
        let dist = mix(0.3, 0.93, k);
        let r = mix(0.06, 0.018, k) * mix(0.6, 1.25, hash11(s + 2.0));
        let elong = mix(1.4, 3.4, k);
        let d = p - dir * dist;
        let local = vec2<f32>(dot(d, dir) / elong, dot(d, vec2<f32>(-dir.y, dir.x)));
        f += r * r / max(dot(local, local), 1e-6);
    }
    // Salpicaduras sueltas alrededor.
    for (var i = 0; i < 14; i++) {
        let s = seed + 200.0 + f32(i) * 3.91;
        let a = (hash11(s) - 0.5) * 3.6;
        let c = vec2<f32>(cos(a), sin(a)) * mix(0.35, 0.95, hash11(s + 1.0));
        let r = mix(0.008, 0.022, hash11(s + 2.0));
        let d = p - c;
        f += r * r / max(dot(d, d), 1e-6);
    }
    return f;
}

@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    let screen_pos = input.position.xy / camera.screenSize;
    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    let world_pos = getWorldCoords(screen_pos, depth, camera);

    let rel = world_pos - input.decal_top_left;
    let axis_x_len = length(input.decal_axis_x);
    let axis_z_len = length(input.decal_axis_z);
    let axis_y_len = length(input.decal_axis_y);
    let amount_of_x = dot(rel, input.decal_axis_x) / (axis_x_len * axis_x_len);
    let amount_of_z = dot(rel, input.decal_axis_z) / (axis_z_len * axis_z_len);
    let amount_of_y = dot(rel, input.decal_axis_y) / (axis_y_len * axis_y_len);
    if (amount_of_x < 0.0 || amount_of_x > 1.0 || amount_of_z < 0.0 || amount_of_z > 1.0) {
        discard;
    }
    if (abs(amount_of_y) > 0.5) { discard; }

    let orig_N = textureSample(gBufferNormals, samplerState, screen_pos);
    let surface_normal = normalize(octahedral01ToNormal(orig_N.xy));
    if (abs(dot(surface_normal, normalize(input.decal_axis_y))) < 0.3) { discard; }

    let age = saturate((axis_y_len - 0.5) * 2.0);
    let center = input.decal_top_left + (input.decal_axis_x + input.decal_axis_z) * 0.5;
    let seed = fract(dot(floor(center * 37.0), vec3<f32>(0.1031, 0.1137, 0.0973))) * 1000.0;

    // Borde irregular: el punto se desplaza un poco con ruido antes de evaluar el campo.
    var p = vec2<f32>(amount_of_x, amount_of_z) * 2.0 - 1.0;
    p += (vec2<f32>(valueNoise(p * 9.0 + seed), valueNoise(p * 9.0 - seed)) - 0.5) * 0.05;
    let g = log(splatField(p, seed)); // 0 en el borde
    let aa = max(fwidth(g), 1e-3);
    let coverage = smoothstep(-aa, aa, g);
    let vertical = 1.0 - smoothstep(0.35, 0.5, abs(amount_of_y));
    let fade = 1.0 - smoothstep(0.8, 1.0, age);
    let alpha = coverage * vertical * fade;
    if (alpha < 0.01) { discard; }

    // Grosor: sube rápido en el borde (menisco) y se aplana dentro.
    let thickness = smoothstep(0.0, 1.0, g);
    let wet = 1.0 - smoothstep(0.15, 0.7, age);

    // Fresca: fina roja, gruesa casi negra. Seca: marrón oscuro mate.
    let fresh = mix(vec3<f32>(0.1, 0.004, 0.003), vec3<f32>(0.022, 0.001, 0.0008), thickness);
    let dried = mix(vec3<f32>(0.07, 0.016, 0.01), vec3<f32>(0.028, 0.008, 0.005), thickness);
    let albedo = mix(dried, fresh, wet);
    let roughness = mix(0.65, mix(0.3, 0.16, thickness), wet);

    // Relieve (gradiente de superficie de Mikkelsen) de la altura de la película.
    let height = smoothstep(0.0, 0.5, g) * FILM_HEIGHT * mix(0.4, 1.0, wet);
    let dPdx = dpdx(world_pos);
    let dPdy = dpdy(world_pos);
    let r1 = cross(dPdy, surface_normal);
    let r2 = cross(surface_normal, dPdx);
    let det = dot(dPdx, r1);
    let grad = sign(det) * (dpdx(height) * r1 + dpdy(height) * r2);
    let bumped = normalize(abs(det) * surface_normal - grad);
    let N = normalize(mix(surface_normal, bumped, alpha));

    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    var output: DecalFragmentOutput;
    output.albedo = vec4<f32>(mix(orig_albedo.rgb, albedo, alpha), mix(orig_albedo.a, 0.0, alpha));
    let encoded = normalToOctahedral01(N);
    output.normal = vec4<f32>(encoded.xy, mix(orig_N.z, roughness, alpha), orig_N.a);
    return output;
}
