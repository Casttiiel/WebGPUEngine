struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    screenToWorld: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    sourceSize: vec2<f32>,
    cameraFront: vec3<f32>,
    cameraZFar: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) selfIllum: vec4<f32>,
    @location(3) depth: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var txAlbedo: texture_2d<f32>;
@group(2) @binding(1) var txNormal: texture_2d<f32>;
@group(2) @binding(2) var txMetallic: texture_2d<f32>;
@group(2) @binding(3) var txRoughness: texture_2d<f32>;
@group(2) @binding(4) var txEmissive: texture_2d<f32>;
@group(2) @binding(5) var samplerState: sampler;


fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
}

@fragment
fn fs(input: VertexOutput) -> FragmentOutput {
    let albedo_color = textureSample(txAlbedo, samplerState, input.Uv);
    
    if(albedo_color.a < 0.5){
        discard;
    }

    var output: FragmentOutput;

    output.albedo = albedo_color;
    output.albedo.a = textureSample(txMetallic, samplerState, input.Uv).b;

    // Obtener la normal del normal map
    let N_tangent_space = textureSample(txNormal, samplerState, input.Uv) * 2.0 - 1.0;
    
    // Calcular TBN y transformar la normal
    let TBN = computeTBN(normalize(input.N), input.T);
    let N = normalize(TBN * N_tangent_space.xyz);
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g;
    output.normal = encodeNormal(N, roughness);
    
    output.selfIllum = textureSample(txEmissive, samplerState, input.Uv);
    output.selfIllum *= output.selfIllum.a;

    let camb2obj = input.WorldPos - camera.cameraPosition;
    let linear_depth = dot(camb2obj, camera.cameraFront) / camera.cameraZFar;
    output.depth = linear_depth;

    return output;
}