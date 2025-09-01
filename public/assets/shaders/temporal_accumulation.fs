#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var rawAO: texture_2d<f32>;
@group(1) @binding(1) var aoSampler: sampler;

@group(2) @binding(0) var accAO: texture_2d<f32>;
@group(2) @binding(1) var accSampler: sampler;
@group(2) @binding(2) var<uniform> oldCamera: OldCameraUniforms;

@group(3) @binding(0) var gAlbedo: texture_2d<f32>;
@group(3) @binding(1) var gNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(3) @binding(3) var samplerGBuffer: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let AO_current = textureSample(rawAO, aoSampler, uv).x;

    let zLinear = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    // 1. Reconstruir posición view/world
    let worldPos = getWorldCoords(uv, zLinear, camera);

    // 2. Proyectar a la pantalla anterior
    let prevClip = oldCamera.projectionMatrix * oldCamera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let prevNDC = prevClip.xyz / prevClip.w;
    var prevUV = prevNDC.xy * 0.5 + vec2<f32>(0.5, 0.5);
    prevUV.y = 1.0 - prevUV.y;
//return textureSampleLevel(gLinearDepth, samplerGBuffer, prevUV, 0.0).x;
    // 3. Validar prevUV
    var AO_history = textureSampleLevel(accAO, accSampler, prevUV, 0.0).x;
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) {
        // 4. Samplear AO histórico reproyectado
        AO_history = 1.0;
    }
    // 5. Blend temporal
    return lerp(AO_current, AO_history, 0.85);
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    return a * (1.0 - t) + b * t;
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
    let zLinear = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    let viewZ = getViewZ(zLinear);
    let viewRay = computeViewRayFromUV(uv);
    return viewRay * -viewZ;
}