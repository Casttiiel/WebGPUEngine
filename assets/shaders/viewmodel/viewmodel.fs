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

@group(0) @binding(0) var<uniform> vmCamera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
@group(3) @binding(0) var<uniform> mainCamera: CameraUniforms;

struct ViewModelOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fs(input: VertexOutput) -> ViewModelOutput {
    let uv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);

    let albedo = textureSample(txAlbedo, samplerState, uv);
    let albedo_linear = pow(abs(albedo.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;

    // Normal in viewmodel camera space (viewmodel camera has identity view,
    // so viewmodel-world == main camera-space).
    let vmNormal = normalize(input.N);

    // Transform to MAIN world space so lighting responds to camera orientation.
    // mainCamera.viewMatrix is world→camera; its transpose (for pure rotation) is camera→world.
    let viewRot = mat3x3<f32>(
        mainCamera.viewMatrix[0].xyz,
        mainCamera.viewMatrix[1].xyz,
        mainCamera.viewMatrix[2].xyz,
    );
    let worldNormal = normalize(transpose(viewRot) * vmNormal);

    // Simple roughness/metallic from textures
    let roughness = textureSample(txRoughness, samplerState, uv).g * factors.roughnessFactor;
    let metallic  = textureSample(txMetallic,  samplerState, uv).b * factors.metallicFactor;

    // Directional (sun-like) light — world space
    let lightDir   = normalize(vec3<f32>(0.55, 0.8, 0.3));
    let lightColor = vec3<f32>(1.2, 1.05, 0.9);

    // Half-Lambert diffuse (wraps to avoid pitch-black shading)
    let ndotl = dot(worldNormal, lightDir) * 0.5 + 0.5;

    // Blinn-Phong specular in viewmodel space (view dir = toward camera origin)
    let viewDir = normalize(-input.WorldPos);
    let halfDir = normalize(lightDir + (transpose(viewRot) * viewDir));
    let specPow = mix(8.0, 128.0, 1.0 - roughness);
    let spec    = pow(max(dot(worldNormal, halfDir), 0.0), specPow) * (1.0 - roughness);

    // Ambient sky light
    let ambient = vec3<f32>(0.12, 0.14, 0.18);

    // Combine diffuse + specular
    let diffuse   = albedo_linear * (ambient + lightColor * ndotl * (1.0 - metallic * 0.8));
    let specColor = mix(vec3<f32>(spec), albedo_linear * spec, metallic) * lightColor;

    var output: ViewModelOutput;
    output.color = vec4<f32>(diffuse + specColor, albedo.a);
    return output;
}
