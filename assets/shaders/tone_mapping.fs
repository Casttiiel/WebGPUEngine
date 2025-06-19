struct ToneMappingParams {
    minLogLuminance: f32,
    maxLogLuminance: f32,
    tau: f32,          // Adaptation speed
    exposure: f32,
};

@group(0) @binding(0) var gAlbedo: texture_2d<f32>;
@group(0) @binding(1) var defaultSampler: sampler;
@group(0) @binding(2) var averageLuminance: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: ToneMappingParams;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

fn Uncharted2Tonemap(x: vec3<f32>) -> vec3<f32> {
    let A: f32 = 0.15;
    let B: f32 = 0.50;
    let C: f32 = 0.10;
    let D: f32 = 0.20;
    let E: f32 = 0.02;
    let F: f32 = 0.30;

    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - (E / F);
}

fn toneMappingUncharted2(x: vec3<f32>) -> vec3<f32> {
    let ExposureBias: f32 = 2.0;
    let W: f32 = 11.2;

    let curr = Uncharted2Tonemap(ExposureBias * x);
    let whiteScale = vec3<f32>(1.0) / Uncharted2Tonemap(vec3<f32>(W));

    return curr * whiteScale;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // Get adaptive average luminance
    let avgLogLuminance = textureLoad(averageLuminance, vec2<i32>(0, 0), 0).r;
    let logLuminanceRange = params.maxLogLuminance - params.minLogLuminance;
    let avgLuminance = exp2(avgLogLuminance * logLuminanceRange + params.minLogLuminance);    // Calculate adaptive exposure with un poco más de protección para highlights
    let adaptedLum = params.exposure / (avgLuminance + 0.005);
    
    var hdrColor = textureSample(gAlbedo, defaultSampler, input.uv);
    // Aplicamos una curva suave antes del tone mapping para preservar más detalles
    let exposedColor = hdrColor.xyz * adaptedLum;
    let compressedColor = exposedColor / (vec3<f32>(1.0) + exposedColor);
    
    // Aplicamos el tone mapping con un poco más de control en las altas luces
    let tmColorUC2 = toneMappingUncharted2(compressedColor);
    return vec4<f32>(tmColorUC2, 1.0);
}