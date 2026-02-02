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

struct StoneVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>
};

fn worldNoise(
    tx: texture_2d<f32>,
    samp: sampler,
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    scale: f32,
    channel: u32
) -> f32 {

    let n = abs(normal);
    let blend = n / (n.x + n.y + n.z);

    let uvX = worldPos.yz * scale;
    let uvY = worldPos.xz * scale;
    let uvZ = worldPos.xy * scale;

    var x: f32;
    var y: f32;
    var z: f32;

    if (channel == 0u) {
        x = textureSample(tx, samp, uvX).r;
        y = textureSample(tx, samp, uvY).r;
        z = textureSample(tx, samp, uvZ).r;
    } else if (channel == 1u) {
        x = textureSample(tx, samp, uvX).g;
        y = textureSample(tx, samp, uvY).g;
        z = textureSample(tx, samp, uvZ).g;
    } else {
        x = textureSample(tx, samp, uvX).b;
        y = textureSample(tx, samp, uvY).b;
        z = textureSample(tx, samp, uvZ).b;
    }

    return x * blend.x + y * blend.y + z * blend.z;
}

//// ----------------------------------------------------
//// FRAGMENT
//// ----------------------------------------------------

@fragment

fn fs(input: StoneVertexOutput) -> FragmentOutput {

    // --- World mapping ---
    let Uv = input.Uv * vec2<f32>(factors.uvXScale,factors.uvYScale);

    let albedo_color = textureSample(txAlbedo, samplerState, Uv);
    
    var output: FragmentOutput;

    let Nw = normalize(input.N);

        // Escalas
        let scaleR = 0.010;
        let scaleG = 0.023;
        let scaleB = 0.037;

        // Offsets
        let offsetR = vec3<f32>(13.7, 91.2, 47.4);
        let offsetG = vec3<f32>(71.4, 29.1, 83.6);
        let offsetB = vec3<f32>(52.9, 64.3, 11.8);

    let brushR = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetR,
        Nw,
        scaleR,
        0u
    );

    let brushG = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetG,
        Nw,
        scaleG,
        1u
    );

    let brushB = worldNoise(
        txEmissive,
        samplerState,
        input.WorldPos + offsetB,
        Nw,
        scaleB,
        2u
    );


    var brush = brushR * 0.5 + brushG * 0.35 + brushB * 0.15;
    brush = pow(brush, 1.5);
    let brushMask = smoothstep(0.2, 0.8, brush);
    let brushDirection = abs(dot(Nw, normalize(vec3<f32>(0.3, 1.0, 0.2))));
    let directionalMask = mix(brushMask * 0.6, brushMask, brushDirection);

    let baseColor = albedo_color.rgb * factors.baseColorFactor.rgb;

    // Variación pictórica de valor
    let paintedColor = mix(
        baseColor * 0.85,   // pintura lavada
        baseColor * 1.15,   // pincel cargado
        directionalMask
    );

    output.albedo = vec4<f32>(paintedColor, 1);
    output.albedo.a = textureSample(txMetallic, samplerState, Uv).b * factors.metallicFactor;

    // Obtener la normal del normal map
    let N_tangent_space = textureSample(txNormal, samplerState, Uv) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);
    
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g * factors.roughnessFactor;
    let finalRoughness = clamp(
        roughness * mix(0.85, 1.15, brush),
        0.04,
        1.0
    );
    let encodedNormal = normalToOctahedral01(N);

    let emissive = 0.0;

    // Pack octahedral normal + roughness en RGBA8
    output.normal = vec4<f32>(
        encodedNormal.x,
        encodedNormal.y,
        finalRoughness,
        emissive
    );

    let camb2obj = input.WorldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    output.depth = linear_depth;

    return output;
}