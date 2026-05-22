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

// Camera uniforms
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var samplerGBuffer: sampler;      // Shared sampler

// SSR Parameters
@group(2) @binding(0) var accLight: texture_2d<f32>;
@group(2) @binding(1) var aoTexture: texture_2d<f32>;
@group(2) @binding(2) var brdfLUT: texture_2d<f32>;
@group(2) @binding(3) var texSampler: sampler;
@group(2) @binding(4) var<uniform> ssrParams: SSRUniforms;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    let g = decodeGBuffer(uv);

    // Early exit if SSR is disabled
    if (ssrParams.enabled < 0.5 || g.metallic < 0.1 || g.roughness > 0.9) {
        return vec4<f32>(0.0);
    }
    
    // Perform ray marching in screen space
    let reflectionColor = performScreenSpaceRayMarching(
        g.worldPos,
        g.reflectedDir,
        uv,
        g.zlinear,
        g
    );

    let reflectionContribution = applyFresnelBRDF(reflectionColor.rgb, g);
    return vec4<f32>(reflectionContribution, reflectionColor.a);
}

fn applyFresnelBRDF(color: vec3<f32>, g: GBuffer) -> vec3<f32> {
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);    
    let NdotV = max(dot(N, V), 0.0);
    let F0 = g.specularColor;
    let F = Fresnel_Schlick_Roughness(NdotV, F0, g.roughness);
    let brdfCoords = vec2<f32>(clamp(g.roughness, 0.0, 1.0), clamp(1.0 - NdotV, 0.0, 1.0));
    let brdf = textureSampleLevel(brdfLUT, texSampler, brdfCoords, 0.0).rg;
    return color * (F * brdf.x + brdf.y);
}

fn performScreenSpaceRayMarching(
    startPos: vec3<f32>,
    rayDir: vec3<f32>,
    startUV: vec2<f32>,
    startDepth: f32,
    g: GBuffer
) -> vec4<f32> {
    
    let stepSize = ssrParams.stepSize;
    let maxSteps = i32(ssrParams.maxSteps);
    let maxDistance = ssrParams.maxDistance;
    let thickness = ssrParams.thickness;
    
    var currentPos = startPos;
    
    // Ray marching loop
    for (var i = 0; i < maxSteps; i++) {
        
        // Advance ray
        currentPos += rayDir * stepSize;

        let currentDistance = length(currentPos - startPos);
        if (currentDistance > maxDistance) {
            break; // Early exit - save GPU cycles
        }

        let viewPos = camera.viewMatrix * vec4<f32>(currentPos, 1.0);
        
        if (viewPos.z > 0.0) {
            break;
        }
        
        // Project to screen space
        let clipPos = camera.projectionMatrix * viewPos;
        let ndc = clipPos.xyz / clipPos.w;        
        var screenUV = ndc.xy * 0.5 + 0.5;
        screenUV.y = 1.0 - screenUV.y;

        // Check if ray is outside screen
        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
            break;
        }
        
        // Sample depth at current screen position
        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let camb2obj = currentPos - camera.cameraPosition.xyz;
        let currentDepth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
        
        // Check for intersection
        if ((currentDepth > sampledDepth && (currentDepth - sampledDepth) < ssrParams.thickness) && sampledDepth > startDepth) {
            // Hit! Sample color at this position
            let hitColor = textureSampleLevel(accLight, texSampler, screenUV, 0.0);
            
            // Fade based on distance and edge proximity
            let distanceFade = 1.0 - (currentDistance / maxDistance);
            let edgeFade = calculateEdgeFade(screenUV);
            let stepFade = 1.0 - (f32(i) / f32(maxSteps));
            let finalFade = clamp(distanceFade * edgeFade * stepFade, 0.0, 1.0);
            
            return vec4<f32>(hitColor.rgb, finalFade);
        }
    }
    
    // No hit found
    return vec4<f32>(0.0);
}

fn calculateEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fadeX = min(uv.x / fadeWidth, (1.0 - uv.x) / fadeWidth);
    let fadeY = min(uv.y / fadeWidth, (1.0 - uv.y) / fadeWidth);
    return min(fadeX, fadeY);
}
