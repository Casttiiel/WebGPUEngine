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
    localPos: vec3<f32>,
    blend: vec3<f32>,
    scale: f32
) -> vec4<f32> {
    let xProj = textureSample(tex, smp, localPos.yz * scale);
    let yProj = textureSample(tex, smp, localPos.xz * scale);
    let zProj = textureSample(tex, smp, localPos.xy * scale);

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
    localPos: vec3<f32>,
    blend: vec3<f32>,
    scale: f32
) -> vec3<f32> {
    // Leer los 3 normales proyectados
    let nX = textureSample(tex, smp, localPos.yz * scale).xyz * 2.0 - 1.0;
    let nY = textureSample(tex, smp, localPos.xz * scale).xyz * 2.0 - 1.0;
    let nZ = textureSample(tex, smp, localPos.xy * scale).xyz * 2.0 - 1.0;

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
    // === TRIPLANAR CON ROTACIÓN PERO SIN ESCALA ===
    // Queremos que la textura rote con la mesh pero mantenga tamaño constante
    // independientemente de la escala del objeto
    
    // Calcular la escala del objeto comparando world vs local
    let localPos = input.Pos;
    let worldPos = input.WorldPos;
    
    // Extraer solo la rotación eliminando la escala
    // Esto se logra normalizando cada eje de la transformación
    let scaleX = length(vec3<f32>(worldPos.x - localPos.x * 0.0, 0.0, 0.0));
    let scaleY = length(vec3<f32>(0.0, worldPos.y - localPos.y * 0.0, 0.0));
    let scaleZ = length(vec3<f32>(0.0, 0.0, worldPos.z - localPos.z * 0.0));
    
    // Método más robusto: calcular escala promedio desde las normales
    // Las normales están normalizadas, así que al transformarlas perdemos info de escala
    // Usamos la diferencia entre world y local dividida por local
    let localLen = length(localPos);
    let worldLen = length(worldPos);
    let avgScale = select(1.0, worldLen / localLen, localLen > 0.001);
    
    // Posición rotada pero sin escala
    let rotatedPos = worldPos / avgScale;
    
    let Nw = normalize(input.N);
    let blend = triplanarBlendWeights(Nw);

    // factors.uvXScale controla directamente el tiling de la textura
    let scale = factors.uvXScale;

    // Albedo (color)
    let albedo_color = triplanarSample(
        txAlbedo,
        samplerState,
        rotatedPos,
        blend,
        scale
    );

    // Metallic (solo canal B)
    let metallic_value = triplanarSample(
        txMetallic,
        samplerState,
        rotatedPos,
        blend,
        scale
    ).b;

    // Roughness (solo canal G)
    let roughness_value = triplanarSample(
        txRoughness,
        samplerState,
        rotatedPos,
        blend,
        scale
    ).g;

    // Emissive (canal R)
    let emissive_value = triplanarSample(
        txEmissive,
        samplerState,
        rotatedPos,
        blend,
        scale
    ).r;

    // Normal (en espacio rotado)
    let N = triplanarNormal(
        txNormal,
        samplerState,
        rotatedPos,
        blend,
        scale
    );

    // === Empaquetado de normal + roughness ===
    let encodedNormal = normalToOctahedral01(N);

    var output: FragmentOutput;

    // Linearize sRGB albedo before applying factor (same as gbuffer.fs)
    let albedo_linear = pow(abs(albedo_color.rgb), vec3<f32>(2.2));
    output.albedo = vec4<f32>(albedo_linear * factors.baseColorFactor.rgb, albedo_color.a);
    output.albedo.a = metallic_value * factors.metallicFactor;

    // Specular Anti-Aliasing (same as gbuffer.fs)
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
