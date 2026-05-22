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

// Shadow mapping utilities - common functions
// Level 3: Depends on core/constants




// Kernel Poisson pre-computado (8 taps, distribución uniforme)
const poissonDisk: array<vec2<f32>, 8> = array<vec2<f32>, 8>(
    vec2<f32>(-0.9450, -0.3165),
    vec2<f32>(-0.6926,  0.5763),
    vec2<f32>(-0.2654, -0.8867),
    vec2<f32>( 0.1566,  0.4173),
    vec2<f32>(-0.1322,  0.9346),
    vec2<f32>( 0.5915, -0.5831),
    vec2<f32>( 0.8743,  0.2891),
    vec2<f32>( 0.3865, -0.1276)
);

fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    
    // Out of bounds check
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    let texelSize = lightShadowStepDivResolution;
    let kernelRadius = texelSize * 1.5;

    // Sin snap — Poisson distribuye los taps de forma que el noise
    // es isotrópico y no produce banding estructural
    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        let offset = poissonDisk[i] * kernelRadius;
        shadow += textureSampleCompareLevel(
            shadowMap, shadowSampler,
            lightUVSpacePos.xy + offset,
            lightUVSpacePos.z
        );
    }
    return shadow / 8.0;
}


// PCF cube shadow for omnidirectional (point) lights.
//
// KEY: the depth stored in each cubemap face was written by a perspective camera
// whose view-space Z equals the *dominant axis component* of dir, not length(dir).
// Using length(dir) for the reference is wrong and causes everything to appear in shadow,
// especially on the faces pointing up/down where horizontal spread makes dist >> faceZ.
fn getShadowFactorCube(
    wPos: vec3<f32>,
    lightPos: vec3<f32>,
    shadowNear: f32,
    shadowFar: f32,
    invResolution: f32,   // 1.0 / shadowResolution — for texel-accurate bias
    shadowCube: texture_depth_cube,
    shadowSampler: sampler_comparison,
) -> f32 {
    let dir  = wPos - lightPos;
    let dist = length(dir);

    // Perspective depth constants (ZO — zero-to-one, matching perspectiveZO)
    let A = shadowFar / (shadowFar - shadowNear);
    let B = -(shadowFar * shadowNear) / (shadowFar - shadowNear); // B < 0

    // Problem 1 fix — texel-accurate bias.
    // 1 texel in world space at a face = 2*faceZ / shadowResolution (FOV 90°).
    // Converting to NDC: dDepth/dfaceZ = |B|/faceZ², so
    //   texelBias = (2*faceZ/res) * |B|/faceZ² = 2*|B| / (res*faceZ)
    // We apply it per-tap below where each tap has its own faceZ.

    // Problem 3 fix — smooth kernel with a guaranteed minimum so it never
    // collapses near the light or explodes far away.
    let kernelRadius = 0.02 * dist + 0.001;

    // Tangent frame built on the ORIGINAL dir (Problem 2 fix — see tap loop).
    let dirN    = normalize(dir);
    let worldUp = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(dirN.y) < 0.99);
    let right   = normalize(cross(dirN, worldUp));
    let up      = normalize(cross(right, dirN));

    var shadow = 0.0;
    for (var i = 0; i < 8; i++) {
        // Offset applied in original (uncorrected) direction space.
        let tapDir = dir + right * poissonDisk[i].x * kernelRadius
                        + up    * poissonDisk[i].y * kernelRadius;

        // Problem 2 fix — apply the gl-matrix/WebGPU cubemap correction per tap.
        // Every tap may land on a different face, so each needs its own correction:
        //   ±X dominant: negate Z   |   ±Y / ±Z dominant: negate X
        let tapAbs  = abs(tapDir);
        let tapXDom = tapAbs.x >= tapAbs.y && tapAbs.x >= tapAbs.z;
        let tapSampleDir = select(
            vec3<f32>(-tapDir.x,  tapDir.y,  tapDir.z),
            vec3<f32>( tapDir.x,  tapDir.y, -tapDir.z),
            tapXDom
        );

        // Depth and bias computed for this tap's face.
        let tapFaceZ    = max(max(tapAbs.x, tapAbs.y), tapAbs.z);
        let tapFaceZs   = max(tapFaceZ, 0.0001);
        let texelBias   = 2.0 * abs(B) * invResolution / tapFaceZs; // ~1.5 texels
        let tap_depth   = clamp(A + B / tapFaceZs - texelBias * 1.5, 0.0, 1.0);
        let tap_in_range = tapFaceZ >= shadowNear && tapFaceZ <= shadowFar;
        let tap_cmp     = select(0.0, tap_depth, tap_in_range);

        shadow += textureSampleCompare(shadowCube, shadowSampler, tapSampleDir, tap_cmp);
    }
    return shadow / 8.0;
}

fn getShadowFactorSimple(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    
    // Out of bounds check
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    return textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy, lightUVSpacePos.z);
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

// LightUniforms for point lights with shadow support.
// Fields that are irrelevant for point lights are repurposed:
//   viewProjOffset  — unused (point lights have no single view-projection)
//   shadowStep      — repurposed as shadowNear (near plane of each cube face camera)
//   shadowInverseResolution — repurposed as shadowFar (far plane = light radius)
struct LightUniforms {
    color: vec3<f32>,
    hasShadows: f32,             // 16 bytes (0-15)
    position: vec3<f32>,         // 12 bytes (16-27)
    intensity: f32,              // 4 bytes  (28-31)
    viewProjOffset: mat4x4<f32>, // 64 bytes (32-95) — unused for point lights
    radius: f32,                 // 4 bytes  (96-99)
    shadowNear: f32,             // 4 bytes  (100-103) repurposed from shadowStep
    shadowFar: f32,              // 4 bytes  (104-107) repurposed from shadowInverseResolution
    shadowStepDivResolution: f32,// 4 bytes  (108-111) unused
    startFalloff: f32,           // 4 bytes  (112-115)
    padding: vec3<f32>,          // 12 bytes (116-127)
    extraPadding: f32,           // 4 bytes  (128-131)
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(3) @binding(0) var<uniform> light: LightUniforms;
@group(3) @binding(1) var gPointShadowCube: texture_depth_cube;
@group(3) @binding(2) var gShadowSampler: sampler_comparison;
@group(3) @binding(3) var projectorTexture: texture_2d<f32>; // bound to white, unused
@group(3) @binding(4) var projectorSampler: sampler;

@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

@fragment
fn PS_point_lights_shadow(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = position.xy / camera.screenSize;
    let g = decodeGBuffer(pos);

    let light_dir_full = light.position.xyz - g.worldPos;
    let distance_to_light = length(light_dir_full);
    let light_dir = light_dir_full / distance_to_light;

    // Normal bias: shift the shadow query point along the surface normal,
    // scaled by the angle of incidence — maximum at grazing angles where
    // depth-only bias is insufficient to prevent acne on flat surfaces.
    let NdL_raw = dot(g.normal, light_dir);
    let normalBiasScale = clamp(1.0 - NdL_raw, 0.0, 1.0);
    let biasedWorldPos = g.worldPos + g.normal * 0.05 * normalBiasScale;

    // Shadow sample MUST happen before any non-uniform early return.
    let shadow_factor = getShadowFactorCube(
        biasedWorldPos,
        light.position.xyz,
        light.shadowNear,
        light.shadowFar,
        light.shadowStepDivResolution,
        gPointShadowCube,
        gShadowSampler,
    );

    let NdL = max(NdL_raw, 0.0);
    let NdV = max(dot(g.normal, g.viewDir), 0.0);

    let h = normalize(light_dir + g.viewDir);
    let NdH = saturate(dot(g.normal, h));
    let VdH = saturate(dot(g.viewDir, h));
    let LdV = saturate(dot(light_dir, g.viewDir));
    let a = max(0.001, g.roughness * g.roughness);

    let cDiff = Diffuse(g.albedo);
    let cSpec = Specular(g.specularColor, h, g.viewDir, light_dir, a, NdL, NdV, NdH, VdH, LdV);

    // Inner/outer radius attenuation (same as non-shadow point light)
    let d = distance_to_light;
    let r0 = light.startFalloff;
    let r1 = light.radius;
    var att = 1.0;
    if (d > r0) {
        let t = saturate((d - r0) / max(r1 - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let F = Fresnel_Schlick_Roughness(VdH, g.specularColor, g.roughness);
    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);

    let diffuse_contrib  = kD * cDiff;
    let specular_contrib = cSpec;

    let hl = halfLambert(NdL);
    let ao  = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, pos, 0.0).b;
    let ms  = microShadow(ao, NdL);
    let final_color = light.color.xyz * light.intensity * shadow_factor * (diffuse_contrib * hl + specular_contrib * NdL) * att * ms;
    return vec4<f32>(final_color, 1.0);
}
