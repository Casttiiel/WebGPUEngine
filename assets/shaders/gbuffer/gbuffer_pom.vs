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

// Shared by gbuffer_pom.vs / gbuffer_pom.fs.

struct POMVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    // Object box (unit cube × model matrix): world centre, unit axes, half extents in metres.
    @location(4) @interpolate(flat) BoxCenter: vec3<f32>,
    @location(5) @interpolate(flat) BoxAxisX: vec3<f32>,
    @location(6) @interpolate(flat) BoxAxisY: vec3<f32>,
    @location(7) @interpolate(flat) BoxAxisZ: vec3<f32>,
    @location(8) @interpolate(flat) BoxHalf: vec3<f32>,
}

// MaterialFactors + the extras block at offset 48 (renderer/resources/MaterialExtras.ts:
// same order, vec3s unpacked as three floats so nothing gets padded).
struct PomFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,
    pomScale: f32,
    // extras
    pomShadow: f32,
    layerCoverage: f32,
    layerNoiseScale: f32,
    layerSharpness: f32,
    layerUvScale: f32,
    antiTileScale: f32,
    cavityDirt: f32,
    baseDirtHeight: f32,
    dirtColorR: f32,
    dirtColorG: f32,
    dirtColorB: f32,
    baseDirtStrength: f32,
    layerTintR: f32,
    layerTintG: f32,
    layerTintB: f32,
    layerHeightOffset: f32,
    ashAmount: f32,
    ashNoiseScale: f32,
    ashSharpness: f32,
    ashColorR: f32,
    ashColorG: f32,
    ashColorB: f32,
    _extrasPad0: f32,
    _extrasPad1: f32,
}


// Vertex stage of the POM G-buffer techniques.
//   INSTANCED  model matrix from the instance storage buffer (gbuffer_pom_instanced.tech)
// The box frame (centre, axes, half extents of the unit cube scaled by the model matrix)
// is always passed: the BOX / SILHOUETTE fragment paths project and clip with it.

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
#ifdef INSTANCED
@group(2) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;
#else
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
#endif

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @builtin(instance_index) instanceIdx: u32,
) -> POMVertexOutput {
#ifdef INSTANCED
    let model = instanceMatrices[instanceIdx];
#else
    let model = object.modelMatrix;
#endif
    var output: POMVertexOutput;

    let worldPos4 = model * vec4<f32>(position, 1.0);
    let model3x3  = get3x3From4x4(model);

    output.N        = normalize(model3x3 * normal);
    output.T        = vec4<f32>(normalize(model3x3 * tangent.xyz), tangent.w);
    output.WorldPos = worldPos4.xyz;
    output.Uv       = uv;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos4;

    let ax = model[0].xyz;
    let ay = model[1].xyz;
    let az = model[2].xyz;
    output.BoxCenter = model[3].xyz;
    output.BoxAxisX  = normalize(ax);
    output.BoxAxisY  = normalize(ay);
    output.BoxAxisZ  = normalize(az);
    output.BoxHalf   = 0.5 * vec3<f32>(length(ax), length(ay), length(az));

    return output;
}
