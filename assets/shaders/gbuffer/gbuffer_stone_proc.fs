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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

// ─── Hash primitives ──────────────────────────────────────────────────────────

fn hash21(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(0.1031, 0.1030));
    q += dot(q, q.yx + 33.33);
    return fract((q.x + q.y) * q.x);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(hash21(p), hash21(p + vec2<f32>(5.7, 3.1)));
}

fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q += dot(q, q.zyx + 19.19);
    return fract((q.x + q.y) * q.z);
}

// ─── Value noise 2D ───────────────────────────────────────────────────────────

fn vnoise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i),                       hash21(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

// 3 octaves — enough for colour variation, much cheaper than 5
fn fbm3_2d(pin: vec2<f32>) -> f32 {
    var p = pin; var v = 0.0; var a = 0.5;
    v += a * vnoise2(p); p = p * 2.1 + vec2<f32>(1.7, 9.2); a *= 0.5;
    v += a * vnoise2(p); p = p * 2.1 + vec2<f32>(8.3, 2.8); a *= 0.5;
    v += a * vnoise2(p);
    return v;
}

// ─── Value noise 3D ──────────────────────────────────────────────────────────

fn vnoise3(p: vec3<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let v000 = hash31(i);
    let v100 = hash31(i + vec3<f32>(1,0,0));
    let v010 = hash31(i + vec3<f32>(0,1,0));
    let v110 = hash31(i + vec3<f32>(1,1,0));
    let v001 = hash31(i + vec3<f32>(0,0,1));
    let v101 = hash31(i + vec3<f32>(1,0,1));
    let v011 = hash31(i + vec3<f32>(0,1,1));
    let v111 = hash31(i + vec3<f32>(1,1,1));
    return mix(
        mix(mix(v000,v100,u.x), mix(v010,v110,u.x), u.y),
        mix(mix(v001,v101,u.x), mix(v011,v111,u.x), u.y),
        u.z
    );
}

// 3 octaves 3D FBM with domain rotation
fn fbm3_3d(pin: vec3<f32>) -> f32 {
    let rx = mat3x3<f32>(
        vec3<f32>( 0.00,  0.80,  0.60),
        vec3<f32>(-0.80,  0.36, -0.48),
        vec3<f32>(-0.60, -0.48,  0.64)
    );
    var p = pin; var v = 0.0; var a = 0.5;
    v += a * vnoise3(p); p = rx * p * 2.0; a *= 0.5;
    v += a * vnoise3(p); p = rx * p * 2.0; a *= 0.5;
    v += a * vnoise3(p);
    return v;
}

// ─── Fast Voronoi: 3x3 grid, pure hash jitter (no FBM inside loop) ───────────
// Returns: .f1=nearest dist, .border=F2-F1 (joint width), .cellId

struct VoronoiResult {
    f1:     f32,
    border: f32,
    cellId: f32,
    f2:     f32,
}

fn voronoi_fast(p: vec2<f32>) -> VoronoiResult {
    let ip = floor(p);
    let fp = fract(p);
    var f1 = 8.0; var f2 = 8.0;
    var cellId = 0.0;

    for (var yy = -1; yy <= 1; yy++) {
        for (var xx = -1; xx <= 1; xx++) {
            let neighbor = vec2<f32>(f32(xx), f32(yy));
            let cell = ip + neighbor;
            // Large jitter (0.88) for organic irregular shapes without FBM cost
            let jitter = hash22(cell) * 0.88;
            let diff = neighbor + jitter - fp;
            let d = dot(diff, diff);
            if (d < f1) {
                f2 = f1; f1 = d;
                cellId = hash21(cell + 0.5);
            } else if (d < f2) {
                f2 = d;
            }
        }
    }

    var r: VoronoiResult;
    r.f1     = sqrt(f1);
    r.f2     = sqrt(f2);
    r.border = r.f2 - r.f1;
    r.cellId = cellId;
    return r;
}

// ─── Fragment Entry ───────────────────────────────────────────────────────────

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {

    // uvXScale: tamaño de los adoquines. Valor sugerido: 3.0
    let tileScale = max(factors.uvXScale * 0.15, 0.3);

    let geoN = normalize(input.N);
    let wXZ  = abs(geoN.y);  // peso suelo (XZ)

    // ── Single triplanar Voronoi (1 call blended from XZ+XY) ─────────────────
    let pXZ = input.WorldPos.xz * tileScale;
    let pXY = input.WorldPos.xy * tileScale + vec2<f32>(13.7, 5.3);

    let vorXZ = voronoi_fast(pXZ);
    let vorXY = voronoi_fast(pXY);

    let f1     = mix(vorXY.f1,     vorXZ.f1,     wXZ);
    let border = mix(vorXY.border, vorXZ.border, wXZ);
    let cellId = mix(vorXY.cellId, vorXZ.cellId, wXZ);

    // ── Juntas (mortar) ───────────────────────────────────────────────────────
    // Ancho de junta ligeramente variable con fbm2d barato
    let jointWidth = 0.12 + fbm3_2d(pXZ * 0.6 + vec2<f32>(2.2, 8.8)) * 0.06;
    let jointMask  = smoothstep(0.0, jointWidth, border); // 0=junta, 1=piedra
    let jointDepth = 1.0 - jointMask;

    // ── Grietas dentro del adoquín (1 voronoi a mayor escala) ────────────────
    let pCrack     = pXZ * 4.5 + vec2<f32>(cellId * 17.3);
    let crackVor   = voronoi_fast(pCrack);
    let crackWidth = 0.04 + hash21(vec2<f32>(cellId * 7.3, cellId * 3.1)) * 0.05;
    let crackMask  = smoothstep(0.0, crackWidth, crackVor.border);
    let crackDepth = (1.0 - crackMask) * jointMask * 0.7;

    // ── Color ─────────────────────────────────────────────────────────────────
    let cellVar  = (cellId - 0.5) * 0.12;
    // 3-octave macro FBM (replaces fbm5_3d — 2 octaves cheaper)
    let macroFBM = fbm3_3d(input.WorldPos * tileScale * 0.4 + vec3<f32>(1.1, 3.3, 2.2));
    // Single grain pass (was grainA + grainB — save 1 full fbm3_3d call)
    let grain    = fbm3_3d(input.WorldPos * tileScale * 6.0 + vec3<f32>(0.5, 1.2, 9.1));

    let colQuartz   = vec3<f32>(0.68, 0.67, 0.66);
    let colFeldspar = vec3<f32>(0.44, 0.43, 0.45);
    let colMica     = vec3<f32>(0.22, 0.22, 0.24);
    let colWet      = vec3<f32>(0.18, 0.19, 0.21);

    var albedo = mix(colFeldspar, colQuartz, smoothstep(0.45, 0.70, macroFBM));
    albedo     = mix(albedo,      colMica,   smoothstep(0.62, 0.85, macroFBM));
    albedo    += vec3<f32>(cellVar * 0.8, cellVar * 0.7, cellVar);
    albedo    += vec3<f32>((grain - 0.5) * 0.12);

    // Humedad en juntas
    albedo = mix(albedo, colWet, jointDepth * (0.6 + macroFBM * 0.4) * 0.75);
    // Grietas oscuras
    albedo = mix(albedo, vec3<f32>(0.06, 0.06, 0.07), crackDepth * 0.85);

    // ── Bump (1 layer, 4 samples) ─────────────────────────────────────────────
    // Per-cell tilt — free (no extra noise, just hash)
    let tiltAngle = (hash21(vec2<f32>(cellId * 3.7, cellId * 8.1)) - 0.5) * 0.20;
    let tiltDir   = normalize(vec2<f32>(
        hash21(vec2<f32>(cellId * 1.3)) - 0.5,
        hash21(vec2<f32>(cellId * 5.9)) - 0.5
    ));
    let tiltVec = vec3<f32>(tiltDir.x, 0.0, tiltDir.y) * tiltAngle;
    let tiltedN = normalize(geoN + tiltVec - dot(tiltVec, geoN) * geoN);

    // FBM bump: 4 directional samples (was 8)
    let eps        = 0.014;
    let bumpScale  = tileScale * 3.5;
    let b0  = fbm3_3d(input.WorldPos * bumpScale);
    let bx  = fbm3_3d((input.WorldPos + vec3<f32>(eps, 0.0, 0.0)) * bumpScale) - b0;
    let bz  = fbm3_3d((input.WorldPos + vec3<f32>(0.0, 0.0, eps)) * bumpScale) - b0;
    // Y bump only needed on walls; skip on horizontal surfaces — blend by wXZ
    let by  = fbm3_3d((input.WorldPos + vec3<f32>(0.0, eps, 0.0)) * bumpScale) - b0;
    let grad    = vec3<f32>(bx, by * (1.0 - wXZ * 0.8), bz) / eps;
    let tanGrad = grad - dot(grad, tiltedN) * tiltedN;

    let surfaceFactor = jointMask * (1.0 - crackDepth * 0.5);
    var bumpN = normalize(tiltedN + tanGrad * 0.60 * surfaceFactor);

    // Bevel at joint edge: cheap — just tilt toward -geoN proportional to jointDepth
    // (replaces 3 extra voronoi calls for the finite-difference gradient)
    bumpN = normalize(mix(bumpN, tiltedN - geoN * 0.4, jointDepth * 0.35));

    // ── Roughness ─────────────────────────────────────────────────────────────
    let roughness = clamp(
        0.80
        + (macroFBM - 0.5) * 0.08
        + (grain    - 0.5) * 0.05
        + jointDepth * 0.10
        + crackDepth * 0.07,
        0.70, 0.97
    );

    // ── GBuffer output ────────────────────────────────────────────────────────
    var output: FragmentOutput;
    output.albedo = vec4<f32>(clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);

    let enc = normalToOctahedral01(bumpN);
    output.normal = vec4<f32>(enc.x, enc.y, roughness, 0.0);

    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    output.depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;

    return output;
}