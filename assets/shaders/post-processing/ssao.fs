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

// Estructura para parámetros SSAO solamente
struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    aoStrength: f32,
    noiseScale: f32,
}

// Pre-computed Poisson disk samples para mejor distribución
const POISSON_SAMPLES: array<vec3<f32>, 32> = array<vec3<f32>, 32>(
    vec3<f32>( 0.2335,  0.1312,  0.2264),
    vec3<f32>(-0.1987, -0.0190,  0.0565),
    vec3<f32>(-0.0304,  0.2936,  0.3193),
    vec3<f32>(-0.1176, -0.3054,  0.2731),
    vec3<f32>( 0.2369, -0.1882,  0.5412),
    vec3<f32>( 0.1803,  0.3640,  0.6423),
    vec3<f32>(-0.4218,  0.0733,  0.4190),
    vec3<f32>( 0.4171, -0.0650,  0.8055),
    vec3<f32>(-0.4512,  0.3793,  0.8382),
    vec3<f32>( 0.3905, -0.3225,  0.9423),
    vec3<f32>(-0.5750, -0.1124,  0.7492),
    vec3<f32>( 0.0968,  0.6903,  0.8476),
    vec3<f32>(-0.6220,  0.2358,  0.8531),
    vec3<f32>( 0.6155,  0.1357,  0.9303),
    vec3<f32>(-0.2174, -0.6280,  0.8432),
    vec3<f32>( 0.3497,  0.5201,  0.9911),
    vec3<f32>(-0.7253,  0.1122,  0.9325),
    vec3<f32>( 0.7831, -0.0213,  0.9291),
    vec3<f32>(-0.8124, -0.1942,  0.9732),
    vec3<f32>( 0.2435,  0.7343,  0.8941),
    vec3<f32>(-0.1123, -0.7966,  0.9120),
    vec3<f32>( 0.7648,  0.1924,  0.9541),
    vec3<f32>(-0.5473,  0.5930,  0.9612),
    vec3<f32>( 0.0372, -0.8891,  0.9972),
    vec3<f32>( 0.6354, -0.5513,  0.9865),
    vec3<f32>(-0.8712, -0.1234,  0.9944),
    vec3<f32>( 0.4751,  0.7330,  0.9789),
    vec3<f32>(-0.4020, -0.7602,  0.9731),
    vec3<f32>( 0.6899, -0.6822,  0.9914),
    vec3<f32>(-0.8120,  0.4751,  0.9991),
    vec3<f32>( 0.2183, -0.9217,  0.9893),
    vec3<f32>(-0.5394,  0.8301,  0.9973)
);

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0); // z = 1.0 at the far plane
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getViewPosition(uv: vec2<f32>) -> vec3<f32> {
    let z = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * z; // Negative because camera looks down -Z
}

fn getViewZ(linearDepth: f32) -> f32 {
    return mix(0.1, 1000.0, linearDepth);
}

fn getViewPosition2(uv: vec2<f32>) -> vec3<f32> {
    let zLinear = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewZ = getViewZ(zLinear);
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * viewZ;
}


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let samplingDirections = ssaoParams.sampleCount;
    let aoStrength = ssaoParams.aoStrength;
    let radius = ssaoParams.radius;
    let noiseScale = ssaoParams.noiseScale;
    
    // Sample the linear depth to discard background
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    if (linearZ >= 1.0) {
        discard;
    }

    let normalData = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let normalWorld = octahedral01ToNormal(normalData.xy);
    var viewNormal = normalize((camera.viewMatrix * vec4(normalWorld, 0.0)).xyz);
    viewNormal *= vec3<f32>(1.0, -1.0, 1.0);

    let viewPosition = getViewPosition2(uv);

    var randomVec = textureSampleLevel(noiseTexture, samplerGBuffer, uv * noiseScale, 0).rgb * 2.0 - 1.0;
    randomVec.z = 0.0; // Ensure the random vector is in the XY plane
    randomVec = normalize(randomVec); // Normalize the random vector

    //TBN
    let viewTangent = normalize(randomVec - viewNormal * dot(randomVec, viewNormal));
    let viewBitangent = cross(viewNormal, viewTangent);
    let TBN = mat3x3f(viewTangent, viewBitangent, viewNormal);

    var occlusion = 0.0;
    for (var i = 0u; i < samplingDirections; i = i + 1u) {
        var viewSamplePos = TBN * POISSON_SAMPLES[i].xyz;
        viewSamplePos = viewSamplePos * radius + viewPosition;

        let viewSampleDir = normalize(viewSamplePos - viewPosition);
        let NdotS = max(dot(viewNormal, viewSampleDir), 0.0);

        let clipPos = camera.projectionMatrix * vec4f(viewSamplePos, 1.0);
        let ndcPos = clipPos.xy / clipPos.w;

        let screenCoord = vec2<f32>(ndcPos.x * 0.5 + 0.5, ndcPos.y * 0.5 + 0.5);

        var sampleDepth = getViewPosition2(screenCoord).z;
        let rangeCheck = smoothstep(0.0, 1.0, radius / abs(viewPosition.z - sampleDepth));

        occlusion += select(0.0, 1.0, sampleDepth >= viewSamplePos.z) * rangeCheck * pow(NdotS, 2.0);
    }

    occlusion = 1 - (occlusion / f32(samplingDirections));
    let finalOcclusion = pow(occlusion, aoStrength);

    return finalOcclusion;
}