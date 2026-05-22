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

// ─── Bind groups ────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@group(3) @binding(0) var gBufferAlbedo:  texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(3) @binding(3) var samplerGBuffer: sampler;

// ─── Output — writes two GBuffer targets (partial_gbuffer) ───────────────────
struct DecalFlatOutput {
    @location(0) albedo: vec4<f32>,   // RGB = albedo linear,  A = metallic
    @location(1) normal: vec4<f32>,   // RG  = octahedral N,   B = roughness, A = emissive
}

@fragment
fn fs(input: VertexOutput) -> DecalFlatOutput {
    let uvScaled = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);
    // UV unjittering: remove per-frame jitter displacement so texture samples
    // are stable across frames (jitter should only shift vertex positions, not UVs).
    let jitter_px = camera.jitterOffset * camera.screenSize;
    let uv = uvScaled - dpdx(uvScaled) * jitter_px.x - dpdy(uvScaled) * jitter_px.y;

    // ── Sample decal textures ────────────────────────────────────────────────
    let albedo_srgb     = textureSample(txAlbedo,    samplerState, uv);
    let alpha           = albedo_srgb.a * factors.baseColorFactor.a;

    // Discard invisible pixels early to avoid unnecessary GBuffer reads
    if (alpha < 0.01) { discard; }

    // Linearize sRGB albedo and apply baseColorFactor in linear space
    let decal_albedo    = pow(abs(albedo_srgb.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;
    let decal_metallic  = textureSample(txMetallic,  samplerState, uv).b * factors.metallicFactor;
    let decal_rough_raw = textureSample(txRoughness, samplerState, uv).g * factors.roughnessFactor;
    let decal_emissive  = textureSample(txEmissive,  samplerState, uv).x  * factors.emissiveFactor;

    // ── Read current GBuffer values at this screen pixel ────────────────────
    let screen_uv   = input.position.xy / camera.screenSize;
    let orig_albedo = textureSampleLevel(gBufferAlbedo,  samplerGBuffer, screen_uv, 0.0);
    let orig_normal = textureSampleLevel(gBufferNormals, samplerGBuffer, screen_uv, 0.0);

    // ── Per-channel blend weights from MaterialFactors ───────────────────────
    // appearanceBlend: controls albedo + normal  (0 = leave unchanged, 1 = full blend)
    // surfaceBlend:    controls roughness + metallic
    let app_alpha  = alpha * factors.appearanceBlend;
    let surf_alpha = alpha * factors.surfaceBlend;

    // ── Albedo + metallic blend ───────────────────────────────────────────────
    let out_albedo   = mix(orig_albedo.rgb, decal_albedo,   app_alpha);
    let out_metallic = mix(orig_albedo.a,   decal_metallic, surf_alpha);

    // ── Normal blend: apply decal normal map in mesh TBN, blend WS normals ──
    let N         = normalize(input.N);
    let TBN       = computeTBN(N, input.T);
    let decal_n_ts = textureSample(txNormal, samplerState, uv).xyz * 2.0 - 1.0;
    let decal_n_ws = normalize(TBN * decal_n_ts);
    let orig_n_ws  = octahedral01ToNormal(orig_normal.xy);
    let blended_n_ws = normalize(mix(orig_n_ws, decal_n_ws, app_alpha));
    let encoded_n    = normalToOctahedral01(blended_n_ws);

    // ── Roughness, with Specular Anti-Aliasing applied to the decal normal ───
    let dndx       = dpdx(decal_n_ws);
    let dndy       = dpdy(decal_n_ws);
    let variance   = dot(dndx, dndx) + dot(dndy, dndy);
    let kernel_r2  = min(2.0 * variance * 0.25, 0.18);
    let decal_rough = sqrt(clamp(decal_rough_raw * decal_rough_raw + kernel_r2, 0.0, 1.0));
    let out_roughness = mix(orig_normal.z, decal_rough, surf_alpha);

    // ── Emissive blend (follows appearanceBlend) ──────────────────────────────
    let out_emissive = mix(orig_normal.w, decal_emissive, app_alpha);

    var out: DecalFlatOutput;
    out.albedo = vec4<f32>(out_albedo,  out_metallic);
    out.normal = vec4<f32>(encoded_n,   out_roughness, out_emissive);
    return out;
}
