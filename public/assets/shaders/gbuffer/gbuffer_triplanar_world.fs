#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;


fn triplanarSample(
    tex: texture_2d<f32>,
    smp: sampler,
    worldPos: vec3<f32>,
    blend: vec3<f32>,
    scale: f32
) -> vec4<f32> {
    let xProj = textureSample(tex, smp, worldPos.yz * scale);
    let yProj = textureSample(tex, smp, worldPos.xz * scale);
    let zProj = textureSample(tex, smp, worldPos.xy * scale);

    return xProj * blend.x + yProj * blend.y + zProj * blend.z;
}

fn triplanarBlendWeights(n: vec3<f32>) -> vec3<f32> {
    let an = abs(n);
    let w = an / (an.x + an.y + an.z);
    return w;
}

fn triplanarNormal(
    tex: texture_2d<f32>,
    smp: sampler,
    worldPos: vec3<f32>,
    blend: vec3<f32>,
    scale: f32
) -> vec3<f32> {
    // Leer los 3 normales proyectados
    let nX = textureSample(tex, smp, worldPos.yz * scale).xyz * 2.0 - 1.0;
    let nY = textureSample(tex, smp, worldPos.xz * scale).xyz * 2.0 - 1.0;
    let nZ = textureSample(tex, smp, worldPos.xy * scale).xyz * 2.0 - 1.0;

    // Asignar los ejes correctos (son "normales en espacio de proyección")
    let nx = vec3<f32>(nX.z, nX.x, nX.y);
    let ny = vec3<f32>(nY.x, nY.z, nY.y);
    let nz = vec3<f32>(nZ.x, nZ.y, nZ.z);

    // Combinar
    let n = normalize(nx * blend.x + ny * blend.y + nz * blend.z);
    return n;
}

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
// === TRIPLANAR ===
    let worldPos = input.WorldPos;
    let Nw = normalize(input.N);

    let blend = triplanarBlendWeights(Nw);

    let scale = factors.uvXScale; // o pon otro factor específico

    // Albedo (color)
    let albedo_color = triplanarSample(
        txAlbedo,
        samplerState,
        worldPos,
        blend,
        scale
    );

    // Metallic (solo canal B)
    let metallic_value = triplanarSample(
        txMetallic,
        samplerState,
        worldPos,
        blend,
        scale
    ).b;

    // Roughness (solo canal G)
    let roughness_value = triplanarSample(
        txRoughness,
        samplerState,
        worldPos,
        blend,
        scale
    ).g;

    // Emissive (canal R)
    let emissive_value = triplanarSample(
        txEmissive,
        samplerState,
        worldPos,
        blend,
        scale
    ).r;

    // Normal (WORLD SPACE!)
    let N = triplanarNormal(
        txNormal,
        samplerState,
        worldPos,
        blend,
        scale
    );

    // === Empaquetado de normal + roughness como ya hacías ===
    let encodedNormal = normalToOctahedral01(N);

    var output: FragmentOutput;

    output.albedo = albedo_color * factors.baseColorFactor;
    output.albedo.a = metallic_value * factors.metallicFactor;

    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness_value * factors.roughnessFactor,
        emissive_value * factors.emissiveFactor
    );

    let camb2obj = input.WorldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    output.depth = linear_depth;

    return output;
}