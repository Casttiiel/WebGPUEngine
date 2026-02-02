#include "common/uniforms"
#include "common/structs"
#include "common/math/coordinates"

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
    var blendStrength = 0.8;
    let AO_current = textureSample(rawAO, aoSampler, uv).x;

    let zLinear = textureSampleLevel(gLinearDepth, samplerGBuffer, uv, 0.0).x;
    
    // 1. Reconstruir posición view-space usando la misma lógica que GTAO
    let worldPos = getWorldCoords(uv, zLinear, camera);

    // 2. Proyectar a la pantalla anterior usando oldCamera matrices
    let prevViewPos = oldCamera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let prevClip = oldCamera.projectionMatrix * prevViewPos;
    let prevNDC = prevClip.xyz / prevClip.w;
    var prevUV = prevNDC.xy * 0.5 + vec2<f32>(0.5, 0.5);
    prevUV.y = 1.0 - prevUV.y;

    var AO_history = textureSampleLevel(accAO, accSampler, prevUV, 0.0).x;
    // 3. Validar prevUV
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0)) || prevClip.w < 0.0) {
        // Si prevUV está fuera de pantalla, usar solo AO actual
        return AO_current;
    }
    
    // 4. Blend temporal conservador
    return lerp(AO_current, AO_history, 0.8);
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    return a * (1.0 - t) + b * t;
}