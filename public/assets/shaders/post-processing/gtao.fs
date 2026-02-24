#include "common/uniforms"
#include "common/structs"
#include "common/math/coordinates"
#include "common/math/noise"
#include "common/octahedral"
#include "common/gbuffer"

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

        // Falloff suave hacia el borde del radio
        let falloff = clamp(1.0 - (len / params.radius), 0.0, 1.0);
        let blended = mix(maxCos, cosHorizon, falloff);

        if (blended > maxCos) {
            maxCos = blended;
            // thickness: evita oclusión excesiva por objetos muy finos
            maxCos = mix(maxCos, cosHorizon, params.thicknessMix * (1.0 - falloff));
        }

        if (maxCos > 0.99) { break; }  // horizonte casi vertical, no hay más que ganar
    }

    return maxCos;
}

// ----- visibilidad de una slice -----------------------------
fn computeSlice(
    aoDir     : vec2<f32>,
    uv        : vec2<f32>,
    centerPos : vec3<f32>,
    normalVS  : vec3<f32>,
    vView     : vec3<f32>,
    numSamples: i32,
) -> f32 {
    // Dirección 3D de la slice en view space (punto lejano en esa dirección UV)
    let farUV      = uv + aoDir * 4.0;  // punto de referencia lejos
    let farPos     = sampleViewPos(farUV);
    let sliceDir3D = normalize(farPos - centerPos);

    // Plano de la slice: normal al plano que contiene v y sliceDir3D
    let planeN = normalize(cross(vView, sliceDir3D));

    // Proyectar la normal de superficie en el plano de la slice
    let projNormalRaw = normalVS - planeN * dot(normalVS, planeN);
    let projLen       = length(projNormalRaw);
    if (projLen < 1e-5) { return 1.0; }  // normal perpendicular al plano → sin oclusión

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

    // Ponderar por cuánto de la normal está en el plano de la slice
    return mix(1.0, sliceVis, clamp(projLen, 0.0, 1.0));
}

// ----- fragment principal -----------------------------------
@fragment
fn fs(@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) f32 {

    // Depth del píxel central
    let linearZ = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    if (linearZ >= 1.0) { return 1.0; }  // sky → sin oclusión

    // Posición view-space del píxel central
    let centerPos = reconstructViewPos(uv, linearZ);
    // Normal: world → view space
    let nData   = textureSampleLevel(gNormals, samplerGBuffer, uv, 0.0);
    let nWorld  = octahedral01ToNormal(nData.xy);
    // Transformar a view space (sin traslación)
    var normalVS = normalize((camera.viewMatrix * vec4<f32>(nWorld, 0.0)).xyz);
    normalVS *= vec3<f32>(-1.0, 1.0, -1.0);

    // Verificación de convención: normalVS.z debería ser > 0 para superficies
    // que miran a cámara en right-handed con Z negativo hacia la escena.
    // Si ves toda la escena gris, prueba negar normalVS aquí.

    // Vector hacia cámara en view space
    let vView = normalize(-centerPos);

    // Stride adaptativo: más pequeño lejos, más grande cerca
    let distToCamera = max(-centerPos.z, 0.1);
    let stride = clamp(params.limit / distToCamera, 1.0, params.maxStride);

    // Tamaño de texel del buffer de AO (half res)
    // pos.xy son coordenadas en el framebuffer de AO (half res)
    // Para el jitter usamos coordenadas full-res equivalentes
    let aoRes    = camera.screenSize * 0.5;
    let texelAO  = 1.0 / aoRes;
    let dirScale = texelAO * stride;

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
    var visibility = 0.0;
    let numSamples = i32(params.sampleCount);

    for (var s: i32 = 0; s < sliceCount; s++) {
        // Ángulo base estratificado + jitter
        let baseAngle  = sliceStep * (f32(s) + 0.5);
        let sliceAngle = baseAngle + jitter;

        let aoDir = dirScale * vec2<f32>(sin(sliceAngle), cos(sliceAngle));

        visibility += computeSlice(aoDir, uv, centerPos, normalVS, vView, numSamples);
    }

    visibility /= f32(sliceCount);

    return clamp(pow(visibility, params.aoStrength), 0.0, 1.0);
}
