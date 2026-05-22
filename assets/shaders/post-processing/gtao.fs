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

// Noise and hash functions for procedural generation
// Level 1: Depends on core/constants



// Simple 2D noise function
fn noise2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// 2D hash function - returns vec2 for varied randomness
fn hash2(p: f32) -> vec2<f32> {
    let n = sin(p * 12.9898 + 78.233) * 43758.5453;
    return fract(vec2<f32>(n, n * 1.3));
}

// 3D hash function - single float output
fn hash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
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

struct SSAOParams {
    sampleCount: f32,
    sliceCount: f32,
    radius: f32,
    aoStrength: f32,
    angleOffset: f32,
    spacialOffset: f32,
    falloff: f32,
    thicknessMix: f32,
    maxStride: f32,
    limit: f32,
    padding: f32,
    padding2: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;
@group(2) @binding(3) var noiseSampler: sampler;

const PI_HALF: f32 = 1.5707963267948966192313216916398;

// Reconstruye posición view-space desde UV y depth lineal normalizado [0,1]
// Convención: Z negativo hacia la escena (OpenGL/WebGPU right-handed)
fn reconstructViewPos(uv: vec2<f32>, linearDepth01: f32) -> vec3<f32> {
    let ndc    = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH   = camera.invProjection * ndc;
    let rayDir = rayH.xyz / rayH.w;                    // dirección no normalizada
    let viewZ  = -mix(0.1, camera.cameraFar, linearDepth01); // z < 0
    // escalar rayDir para que su componente Z sea viewZ
    return rayDir * (viewZ / rayDir.z);
}

fn sampleViewPos(uv: vec2<f32>) -> vec3<f32> {
    let d = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    return reconstructViewPos(uv, d);
}

// ----- jitter -----------------------------------------------

// Hash estable por coordenada de píxel full-res → [0, 1)
fn hash1(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

// ----- aproximación rápida acos [Eberly 2014] ---------------
fn fastAcos(x: f32) -> f32 {
    let ax  = abs(x);
    var res = (-0.156583 * ax + PI_HALF) * sqrt(max(0.0, 1.0 - ax));
    return select(PI - res, res, x >= 0.0);
}

// ----- integración analítica del arco (Jimenez 2016) --------
fn integrateArc(h1: f32, h2: f32, n: f32) -> f32 {
    let cosN = cos(n);
    let sinN = sin(n);
    return 0.25 * (
        -cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN +
        -cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN
    );
}

// ----- búsqueda del horizonte en una dirección --------------
fn findHorizon(
    tcBase    : vec2<f32>,   // UV punto de partida
    aoDir     : vec2<f32>,   // paso en UV por sample
    centerPos : vec3<f32>,   // posición view-space del píxel central
    vView     : vec3<f32>,   // vector hacia cámara (normalizado)
    stepSign  : f32,         // +1.0 o -1.0
    numSamples: i32,
) -> f32 {
    var maxCos: f32 = -1.0;

    for (var i: i32 = 1; i <= numSamples; i++) {
        let uvS = tcBase + aoDir * (f32(i) * stepSign);

        // Descartar fuera de pantalla
        if (any(uvS < vec2<f32>(0.0)) || any(uvS > vec2<f32>(1.0))) { break; }

        let depthS = textureSampleLevel(gLinearDepth, samplerGBuffer, uvS, 0.0).x;
        if (depthS >= 1.0) { break; }  // sky

        let posS = reconstructViewPos(uvS, depthS);
        let diff = posS - centerPos;
        let len  = length(diff);

        if (len < 1e-5) { continue; }

        // Fuera del radio: no contribuye
        if (len > params.radius) { continue; }

        let cosHorizon = dot(vView, diff / len);

        if (cosHorizon > maxCos) {
            // Falloff suave hacia el borde del radio; thickness evita oclusión por objetos finos
            let falloff = clamp(1.0 - (len / params.radius), 0.0, 1.0);
            let w = falloff * (1.0 - params.thicknessMix) + params.thicknessMix;
            maxCos = mix(maxCos, cosHorizon, w);
        }

        if (maxCos > 0.99) { break; }  // horizonte casi vertical, no hay más que ganar
    }

    return maxCos;
}

fn computeSlice(
    aoDir     : vec2<f32>,
    uv        : vec2<f32>,
    centerPos : vec3<f32>,
    normalVS  : vec3<f32>,
    vView     : vec3<f32>,
    numSamples: i32,
) -> vec4<f32> { // xyz = weighted bentNormal contribution (view-space), w = visibility
    // Dirección 3D de la slice en view space (punto lejano en esa dirección UV)
    let farUV      = uv + aoDir * 4.0;  // punto de referencia lejos
    let farPos     = sampleViewPos(farUV);
    let sliceDir3D = normalize(farPos - centerPos);

    // Plano de la slice: normal al plano que contiene v y sliceDir3D
    let planeN = normalize(cross(vView, sliceDir3D));

    // Proyectar la normal de superficie en el plano de la slice
    let projNormalRaw = normalVS - planeN * dot(normalVS, planeN);
    let projLen       = length(projNormalRaw);
    if (projLen < 1e-5) { return vec4<f32>(vView, 1.0); }  // normal perpendicular al plano → sin oclusión

    let projNormal = projNormalRaw / projLen;

    // Ángulo n: ángulo entre la normal proyectada y v, con signo
    let cosN = clamp(dot(projNormal, vView), -1.0, 1.0);
    let n    = fastAcos(cosN) - PI_HALF;

    // Buscar horizontes en ambas direcciones
    let h1cos = findHorizon(uv, aoDir, centerPos, vView, -1.0, numSamples);
    let h2cos = findHorizon(uv, aoDir, centerPos, vView,  1.0, numSamples);

    // Convertir cosenos a ángulos y clampear al hemiciclo de la normal
    let h1a = -fastAcos(clamp(h1cos, -1.0, 1.0));
    let h2a =  fastAcos(clamp(h2cos, -1.0, 1.0));

    let h1 = n + max(h1a - n, -PI_HALF);
    let h2 = n + min(h2a - n,  PI_HALF);

    let sliceVis = integrateArc(h1, h2, n);
    let vis = mix(1.0, sliceVis, clamp(projLen, 0.0, 1.0));

    // Bent normal: midpoint of visible arc in the slice plane
    let perpRaw = sliceDir3D - vView * dot(vView, sliceDir3D);
    let perpLen = length(perpRaw);
    var bentContrib: vec3<f32>;
    if (perpLen > 1e-5) {
        let slicePerp = perpRaw / perpLen;
        let thetaBent = (h1 + h2) * 0.5;
        bentContrib = cos(thetaBent) * vView + sin(thetaBent) * slicePerp;
    } else {
        bentContrib = vView;
    }
    return vec4<f32>(bentContrib * clamp(projLen, 0.0, 1.0), vis);
}

// ----- fragment principal -----------------------------------
@fragment
fn fs(@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {

    // Depth del píxel central
    let linearZ = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    if (linearZ >= 1.0) { return vec4<f32>(0.5, 0.5, 1.0, 1.0); }  // sky: neutral bent normal, AO=1

    // Posición view-space del píxel central
    let centerPos = reconstructViewPos(uv, linearZ);
    // Normal: world → view space
    let nData   = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0);
    let nWorld  = octahedral01ToNormal(nData.xy);
    // Transformar a view space (sin traslación)
    var normalVS = normalize((camera.viewMatrix * vec4<f32>(nWorld, 0.0)).xyz);
    normalVS *= vec3<f32>(-1.0, 1.0, -1.0);

    // Vector hacia cámara en view space
    let vView = normalize(-centerPos);

    let distToCamera = max(-centerPos.z, 0.1);

    // Tamaño de texel del buffer de AO (half res)
    let aoRes    = camera.screenSize * 0.5;
    let texelAO  = 1.0 / aoRes;

    // Project world-space radius to pixels at this depth so that numSamples
    // controls sampling density, not the reach of the effect.
    // proj[0][0] = cot(fovX/2) → radius_px = radius * proj[0][0] * aoRes.x / (2 * depth)
    let radiusPx        = params.radius * camera.projectionMatrix[0][0] * aoRes.x / (2.0 * distToCamera);
    let radiusPxClamped = min(radiusPx, params.maxStride * params.sampleCount);
    let dirScale        = texelAO * max(1.0, radiusPxClamped / params.sampleCount);

    // ---- Jitter ----
    // Coordenada en full-res para que el patrón sea consistente
    // independientemente de la resolución del AO
    let fullResPx = floor(pos.xy) * 2.0;  // half→full res

    // Patrón interleaved 4x4: 16 ángulos distintos en un bloque 4x4 de píxeles full-res
    // Esto asegura que píxeles vecinos cubran ángulos complementarios
    let patternPx = vec2<u32>(fullResPx) % vec2<u32>(4u, 4u);
    let patternIdx = f32(patternPx.y * 4u + patternPx.x);  // 0..15

    // Hash fino encima del patrón para romper repetición entre bloques 4x4
    let hashVal = hash1(fullResPx);

    // Ángulo total de jitter: patrón estratificado + hash fino
    // El patrón divide [0, sliceAngleStep) en 16 bins, el hash añade variación dentro del bin
    let sliceCount = i32(params.sliceCount);
    let sliceStep  = TWO_PI / f32(sliceCount);
    let jitter     = (patternIdx + hashVal) / 16.0 * sliceStep;

    // ---- Loop de slices ----
    var visibility    = 0.0;
    var bentAccum     = vec3<f32>(0.0);
    var projWeightSum = 0.0;
    let numSamples    = i32(params.sampleCount);

    for (var s: i32 = 0; s < sliceCount; s++) {
        // Ángulo base estratificado + jitter
        let baseAngle  = sliceStep * (f32(s) + 0.5);
        let sliceAngle = baseAngle + jitter;

        let aoDir = dirScale * vec2<f32>(sin(sliceAngle), cos(sliceAngle));

        let r     = computeSlice(aoDir, uv, centerPos, normalVS, vView, numSamples);
        let projW = clamp(length(r.xyz), 0.0, 1.0); // ≈ projLen (bentContrib is unit vector)
        visibility    += r.w * projW;
        bentAccum     += r.xyz;
        projWeightSum += projW;
    }

    // Weighted average by projLen; fall back to no-occlusion when all slices degenerate
    visibility = select(1.0, visibility / projWeightSum, projWeightSum > 1e-4);

    let ao = clamp(pow(visibility, params.aoStrength), 0.0, 1.0);

    // Pack: rg unused (0.5,0.5), b = AO scalar, a = 1
    return vec4<f32>(0.5, 0.5, ao, 1.0);
}
