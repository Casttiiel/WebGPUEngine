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
    let xProj = textureSampleBias(tex, smp, worldPos.yz * scale, camera.mipBias);
    let yProj = textureSampleBias(tex, smp, worldPos.xz * scale, camera.mipBias);
    let zProj = textureSampleBias(tex, smp, worldPos.xy * scale, camera.mipBias);

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
    let nX = textureSampleBias(tex, smp, worldPos.yz * scale, camera.mipBias).xyz * 2.0 - 1.0;
    let nY = textureSampleBias(tex, smp, worldPos.xz * scale, camera.mipBias).xyz * 2.0 - 1.0;
    let nZ = textureSampleBias(tex, smp, worldPos.xy * scale, camera.mipBias).xyz * 2.0 - 1.0;

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

    // Linearize sRGB albedo before applying factor (same as gbuffer.fs)
    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, albedo_color.a);
    output.albedo.a = metallic_value * factors.metallicFactor;

    // Specular Anti-Aliasing (same as gbuffer.fs — triplanar world normals have screen-space variance too)
    let dndx          = dpdx(N);
    let dndy          = dpdy(N);
    let variance      = dot(dndx, dndx) + dot(dndy, dndy);
    let kernelRough2  = min(2.0 * variance * 0.25, 0.18);
    let roughness_raw = roughness_value * factors.roughnessFactor;
    let rough2        = clamp(roughness_raw * roughness_raw + kernelRough2, 0.0, 1.0);
    let roughness     = sqrt(rough2);

    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        roughness,
        emissive_value * factors.emissiveFactor
    );

    let camb2obj = input.WorldPos - camera.cameraPosition.xyz;
    let linear_depth = dot(camb2obj, camera.cameraFront.xyz) / camera.cameraFar;
    output.depth = linear_depth;

    return output;
}