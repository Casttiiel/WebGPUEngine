@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var defaultSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Convert RGB to luminance using Rec. 709 coefficients
fn getLuminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(inputTexture, defaultSampler, input.uv).rgb;
    let lum = getLuminance(color);    // Convert to log space and normalize to 0-1 range for storage
    let MIN_LOG_LUM = -12.0;
    let MAX_LOG_LUM = 4.0;
    let LOG_RANGE = MAX_LOG_LUM - MIN_LOG_LUM;
    
    let logLum = log2(max(lum, 0.00001));  // Valor mínimo más pequeño para mejor precisión
    let normalizedLogLum = (clamp(logLum, MIN_LOG_LUM, MAX_LOG_LUM) - MIN_LOG_LUM) / LOG_RANGE;
    
    return vec4<f32>(normalizedLogLum, 0.0, 0.0, 1.0);
}
