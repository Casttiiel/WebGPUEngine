#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    aoStrength: f32,
    noiseScale: f32,
    angleOffset: f32,
    spacialOffset: f32,
    padding1: f32,
    padding2: f32
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;
@group(2) @binding(1) var hbaoSampler: sampler;
@group(2) @binding(2) var noiseTexture: texture_2d<f32>;

const PI_HALF: f32 = 1.5707963267948966192313216916398;
const SSAO_FALLOFF      : f32 = 5.5;     // caída lineal de influencia
const SSAO_THICKNESSMIX : f32 = 0.05;     // mezcla para objetos finos
const SSAO_LIMIT        : f32 = 100.0;
const SSAO_MAX_STRIDE   : f32 = 32.0;

@fragment
fn fs(@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) f32 {
    // descartar fondo
    let linearZ = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    if (linearZ >= 1.0) {
        discard;
    }

    // posición y normal en view-space
    let ray        = getViewPosition(uv);
    let nData    = textureSampleLevel(gNormals, hbaoSampler, uv, 0.0);
    let nWorld   = octahedral01ToNormal(nData.xy);
    var normal = normalize((camera.viewMatrix * vec4<f32>(nWorld, 0.0)).xyz);
    normal *= vec3<f32>(-1.0, 1.0, -1.0);

    let v = normalize(-ray);

    let distCenter = max(length(ray), 1e-4);
    let stride = min((1.0 / distCenter) * SSAO_LIMIT, SSAO_MAX_STRIDE);
    let texel = 1.0 / camera.screenSize;
    let dirMult = texel * stride;

    let ix = i32(pos.x);
    let iy = i32(pos.y);
    let pattern = (((ix + iy) & 3) << 2) + (ix & 3);
    let jitter = (hash12(uv * ssaoParams.noiseScale) - 0.5) * (PI / 16.0);
    let dirAngle = (PI / 16.0) * f32(pattern) + ssaoParams.angleOffset + jitter;
    let aoDir = dirMult * vec2<f32>(sin(dirAngle), cos(dirAngle));

    let toDirUnproj = getViewPosition(uv + aoDir);
    let toDir = normalize(toDirUnproj); // dirección hacia sample

    let planeNormal = normalize(cross(v, -toDir));
    let projNormal = normalize(normal - planeNormal * dot(normal, planeNormal));
    let projLen = max(length(projNormal), 1e-6);

    let projectedDir = normalize(toDir + v);
    let cosVal = clamp(dot(-projectedDir, projNormal / projLen), -1.0, 1.0);
    let n = GTAOFastAcos(cosVal) - PI_HALF;

    let phase = ((iy - ix) & 3);
    let tc_base = uv + aoDir * (0.25 * f32(phase) - 0.375 + ssaoParams.spacialOffset);


    var c1: f32 = -1.0;
    var c2: f32 = -1.0;


    // lado “atrás”
    for (var i: i32 = -1; i >= -i32(ssaoParams.sampleCount); i = i - 1) {
        let uv    = tc_base + aoDir * f32(i);
        if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
            break;
        }
        let depth = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
        if (depth >= 1.0) {
            break;
        }
        let val = sliceSample(uv, ray, v, ssaoParams.radius, c1);
        c1 = val;
    }
    // lado “delante”
    for (var i: i32 =  1; i <=  i32(ssaoParams.sampleCount); i = i + 1) {
        let uv    = tc_base + aoDir * f32(i);
        if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
            break;
        }
        let depth = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
        if (depth >= 1.0) {
            break;
        }
        let val = sliceSample(uv, ray, v, ssaoParams.radius, c2);
        c2 = val;
    }

    let c1c = clamp(c1, -1.0, 1.0);
    let c2c = clamp(c2, -1.0, 1.0);

    let h1a = -GTAOFastAcos(c1c);
    let h2a =  GTAOFastAcos(c2c);

    // Clamp al hemisferio de la normal proyectada
    let h1 = n + max(h1a - n, -PI_HALF);
    let h2 = n + min(h2a - n,  PI_HALF);

    let sliceVis = IntegrateArc(h1, h2, n);
    let visibility = mix(1.0, sliceVis, clamp(projLen, 0.0, 1.0));

    // fuerza final y clamp
    return clamp(pow(visibility, ssaoParams.aoStrength), 0.0, 1.0);
}

// [Eberly 2014] aprox acos rápida
fn GTAOFastAcos(x: f32) -> f32 {
    let ax  = abs(x);
    var res = -0.156583 * ax + PI_HALF;
    res *= sqrt(max(0.0, 1.0 - ax));
    return select(PI - res, res, x >= 0.0);
}

// Integración analítica del arco (paper, sección “Integrate Arc”)
fn IntegrateArc(h1: f32, h2: f32, n: f32) -> f32 {
    let cosN = cos(n);
    let sinN = sin(n);
    return 0.25 * (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN
                 - cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN);
}

// Devuelve el “cosine of horizon angle” acumulando el máximo a lo largo de la slice.
// Además aplica falloff lineal por distancia y “thickness mix” para objetos finos.
fn sliceSample(
    uv   : vec2<f32>,
    rayCenter : vec3<f32>,
    vView     : vec3<f32>,
    radius    : f32,
    closest   : f32
) -> f32 {
    // vector desde el centro hacia el sample (en view space)
    let pVS_unproj = getViewPosition(uv);
    let p = pVS_unproj - rayCenter;
    let lenp = length(p);
    if (lenp <= 1e-6) { return -1.0; }

    let current = dot(vView, p / lenp);       // cos(horizonAngle)
    let falloff = clamp((radius - lenp) / SSAO_FALLOFF, 0.0, 1.0);
    var res = closest;
    if(current > closest){
        res = mix(closest, current, falloff);
    }
    return mix(res, current, SSAO_THICKNESSMIX * falloff);
}

fn getCameraVec(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getCameraVecUnproj(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let rayH = camera.invProjection * ndc;
    return rayH.xyz / rayH.w;
}

fn getViewZ(linearDepth: f32) -> f32 {
    return mix(0.1, 1000.0, linearDepth);
}

fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32> {
    let ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0); // z = 1.0 at the far plane
    let rayH = camera.invProjection * ndc;
    return normalize(rayH.xyz / rayH.w);
}

fn getViewPosition(uv: vec2<f32>) -> vec3<f32> {
    let zLinear = textureSampleLevel(gLinearDepth, hbaoSampler, uv, 0.0).x;
    let viewZ = getViewZ(zLinear);
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * -viewZ;
}

// Build tangent basis (tangent, bitangent, normal) in view-space
fn makeTangentBasis(n: vec3<f32>) -> mat3x3<f32> {
    // choose arbitrary up that is not parallel to n
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    return mat3x3<f32>(tangent, bitangent, n);
}

// small hash -> [0,1)
fn hash12(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

// project view-space position to UV (0..1) using projection matrix
fn projectToUV(posVS: vec3<f32>) -> vec2<f32> {
    let clip = camera.projectionMatrix * vec4<f32>(posVS, 1.0);
    let ndc = clip.xyz / clip.w;
    return ndc.xy * 0.5 + vec2<f32>(0.5, 0.5);
}