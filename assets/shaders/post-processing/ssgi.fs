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
// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

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


// SSGI Constants
const NUM_SSGI_SAMPLES: u32 = 16u;
const MAX_RAY_STEPS:    i32 = 32;

// ─── Interleaved Gradient Noise (Jimenez, 2014) ──────────────────────────────
// Temporally varied with camera.time so each rendered frame gets a different
// noise pattern, enabling temporal accumulation / denoising.
fn IGN(pixelCoord: vec2<f32>, sampleIndex: u32) -> f32 {
    let p = pixelCoord + f32(sampleIndex) * vec2<f32>(1.6180339887, 2.6180339887)
          + camera.time * vec2<f32>(1.0, 0.6180339887);
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// ─── Cosine-weighted hemisphere sampling ─────────────────────────────────────
// PDF = cos(theta)/PI  →  the cosine term in the rendering equation cancels,
// so the estimator simplifies to a plain average of hit radiances.
fn cosineSampleHemisphere(u1: f32, u2: f32) -> vec3<f32> {
    let r     = sqrt(u1);
    let theta = 2.0 * PI * u2;
    let x     = r * cos(theta);
    let z     = r * sin(theta);
    // y = cos(polar angle), already carries the cosine IS weight in the PDF
    return vec3<f32>(x, sqrt(max(0.0, 1.0 - u1)), z);
}

// Transform vector from local hemisphere space (Y up) to world space using normal
fn transformToNormalSpace(localDir: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    var tangent = vec3<f32>(1.0, 0.0, 0.0);
    if (abs(normal.x) > 0.9) {
        tangent = vec3<f32>(0.0, 1.0, 0.0);
    }
    let bitangent = normalize(cross(normal, tangent));
    tangent = normalize(cross(bitangent, normal));
    return localDir.x * tangent + localDir.z * bitangent + localDir.y * normal;
}

// ─── Screen-edge fade ─────────────────────────────────────────────────────────
fn computeScreenEdgeFade(uv: vec2<f32>) -> f32 {
    let fadeWidth = 0.1;
    let fx = min(uv.x, 1.0 - uv.x) / fadeWidth;
    let fy = min(uv.y, 1.0 - uv.y) / fadeWidth;
    return saturate(min(fx, fy));
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {    
    
    let g = decodeGBuffer(uv);

    // Early exit if is skybox
    if (g.zlinear > 0.999) {
        return vec4<f32>(0.0);
    }

    var accumColor  = vec3<f32>(0.0);
    var validSamples = 0u;
    
    // Pixel coordinates for IGN (avoids scaling issues)
    let pixelCoord = uv * camera.screenSize;
    
    for (var sampleIndex = 0u; sampleIndex < NUM_SSGI_SAMPLES; sampleIndex++) {
        // Two independent random numbers per sample via IGN
        let u1 = IGN(pixelCoord, sampleIndex * 2u);
        let u2 = IGN(pixelCoord, sampleIndex * 2u + 1u);

        // Cosine-weighted direction in world space
        let localDir      = cosineSampleHemisphere(u1, u2);
        let hemisphereDir = transformToNormalSpace(localDir, g.normal);
        
        let sampleResult = performScreenSpaceRayMarching(
            g.worldPos + g.normal * 0.05,
            hemisphereDir,
        );
        
        if (sampleResult.a > 0.0) {
            // No cosine factor: with cosine-weighted sampling the estimator
            // simplifies to a plain average (cos/PDF = 1).
            accumColor += sampleResult.rgb * sampleResult.a;
            validSamples++;
        }
    }
    
    accumColor /= f32(NUM_SSGI_SAMPLES);
    
    return vec4<f32>(accumColor, 1.0);
}

fn performScreenSpaceRayMarching(
    startPos: vec3<f32>,
    rayDir:   vec3<f32>,
) -> vec4<f32> {
    
    let maxDistance = 50.0;

    var currentPos = startPos;
    var stepSize   = 0.08;   // initial world-space step
    
    // Exponential ray march: 32 steps cover the same range as ~300 fixed steps
    // while front-loading precision where it matters most (close contacts).
    for (var i = 0; i < MAX_RAY_STEPS; i++) {
        
        currentPos += rayDir * stepSize;
        stepSize   = min(stepSize * 1.25, 2.0);   // geometric growth, capped to avoid wasting samples at absurd distances

        let currentDistance = length(currentPos - startPos);
        if (currentDistance > maxDistance) { break; }

        let viewPos = camera.viewMatrix * vec4<f32>(currentPos, 1.0);
        if (viewPos.z > 0.0) { break; }   // ray behind camera
        
        // Project to screen space
        let clipPos  = camera.projectionMatrix * viewPos;
        let ndc      = clipPos.xyz / clipPos.w;        
        var screenUV = ndc.xy * 0.5 + 0.5;
        screenUV.y   = 1.0 - screenUV.y;

        if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) { continue; }
        
        let sampledDepth = textureSampleLevel(gLinearDepth, samplerGBuffer, screenUV, 0.0).r;
        let camb2obj     = currentPos - camera.cameraPosition.xyz;
        let currentDepth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
        
        // Adaptive thickness: looser at distance to avoid missing hits with large steps
        let adaptiveThickness = min(0.02 + currentDistance * 0.005, 0.1);
        
        if (currentDepth > sampledDepth && (currentDepth - sampledDepth) < adaptiveThickness) {
            // Direct albedo sample — cheaper than full decodeGBuffer on every hit
            let hitColor = textureSampleLevel(gAlbedo, samplerGBuffer, screenUV, 0.0).rgb;

            // Fade by screen edge and distance
            let screenFade = computeScreenEdgeFade(screenUV);
            let distFade   = 1.0 - saturate(currentDistance / maxDistance);
            return vec4<f32>(hitColor, screenFade * distFade);
        }
    }
    
    return vec4<f32>(0.0);
}
