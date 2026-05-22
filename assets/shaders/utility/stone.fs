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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

struct StoneVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>
};

fn worldNoise(
    tx: texture_2d<f32>,
    samp: sampler,
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    scale: f32,
    channel: u32
) -> f32 {

    let n = abs(normal);
    let blend = n / (n.x + n.y + n.z);

    let uvX = worldPos.yz * scale;
    let uvY = worldPos.xz * scale;
    let uvZ = worldPos.xy * scale;

    var x: f32;
    var y: f32;
    var z: f32;

    if (channel == 0u) {
        x = textureSample(tx, samp, uvX).r;
        y = textureSample(tx, samp, uvY).r;
        z = textureSample(tx, samp, uvZ).r;
    } else if (channel == 1u) {
        x = textureSample(tx, samp, uvX).g;
        y = textureSample(tx, samp, uvY).g;
        z = textureSample(tx, samp, uvZ).g;
    } else {
        x = textureSample(tx, samp, uvX).b;
        y = textureSample(tx, samp, uvY).b;
        z = textureSample(tx, samp, uvZ).b;
    }

    return x * blend.x + y * blend.y + z * blend.z;
}

//// ----------------------------------------------------
//// FRAGMENT
//// ----------------------------------------------------

@fragment

fn fs(input: StoneVertexOutput) -> FragmentOutput {

    // --- World mapping ---
    let Uv = input.Uv * vec2<f32>(factors.uvXScale,factors.uvYScale);

    let albedo_color = textureSample(txAlbedo, samplerState, Uv);
    
    var output: FragmentOutput;

    let Nw = normalize(input.N);

        // Escalas
        let scaleR = 0.010;
        let scaleG = 0.023;
        let scaleB = 0.037;

        // Offsets
        let offsetR = vec3<f32>(13.7, 91.2, 47.4);
        let offsetG = vec3<f32>(71.4, 29.1, 83.6);
        let offsetB = vec3<f32>(52.9, 64.3, 11.8);

    let brushR = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetR,
        Nw,
        scaleR,
        0u
    );

    let brushG = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetG,
        Nw,
        scaleG,
        1u
    );

    let brushB = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetB,
        Nw,
        scaleB,
        2u
    );


    var brush = brushR * 0.5 + brushG * 0.35 + brushB * 0.15;
    brush = pow(brush, 1.5);
    let brushMask = smoothstep(0.2, 0.8, brush);
    let brushDirection = abs(dot(Nw, normalize(vec3<f32>(0.3, 1.0, 0.2))));
    let directionalMask = mix(brushMask * 0.6, brushMask, brushDirection);

    let baseColor = pow(abs(albedo_color.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;

    // Variación pictórica de valor
    let paintedColor = mix(
        baseColor * 0.85,   // pintura lavada
        baseColor * 1.15,   // pincel cargado
        directionalMask
    );

    output.albedo = vec4<f32>(paintedColor, 1);
    output.albedo.a = textureSample(txMetallic, samplerState, Uv).b * factors.metallicFactor;

    // Obtener la normal del normal map
    let N_tangent_space = textureSample(txNormal, samplerState, Uv) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);
    
    let roughness_raw = textureSample(txRoughness, samplerState, Uv).g * factors.roughnessFactor;

    // Specular Anti-Aliasing — same as gbuffer.fs
    let dndx = dpdx(N);
    let dndy = dpdy(N);
    let variance = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2 = min(2.0 * variance * 0.25, 0.18);
    let rough2 = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let finalRoughness = clamp(
        sqrt(rough2) * mix(0.85, 1.15, brush),
        0.04,
        1.0
    );
    let encodedNormal = normalToOctahedral01(N);

    let emissive = 0.0;

    // Pack octahedral normal + roughness en RGBA8
    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        finalRoughness,
        emissive
    );

    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    let linear_depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    output.depth = linear_depth;

    return output;
}