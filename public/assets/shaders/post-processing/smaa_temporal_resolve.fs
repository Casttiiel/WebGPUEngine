/**
 * SMAA T2x Temporal Resolve Shader
 * 
 * Combina el resultado de SMAA 1x del frame actual con el history buffer
 * usando vecindad color clamp para reducir ghosting.
 * 
 * Inputs:
 * - Current frame (SMAA 1x result)
 * - History buffer (previous frame result)
 * - Velocity buffer (motion vectors)
 * - Jitter offset (subpixel offset actual)
 * 
 * Output:
 * - Temporally accumulated anti-aliased result
 */

// @group(0) = Input textures (FourTexture layout: sampler first, then textures)
@group(0) @binding(0) var txSampler: sampler;               // Linear sampler
@group(0) @binding(1) var txCurrent: texture_2d<f32>;       // SMAA 1x result (current frame)
@group(0) @binding(2) var txHistory: texture_2d<f32>;       // Previous frame result
@group(0) @binding(3) var txVelocity: texture_2d<f32>;      // Motion vectors (RG)

// @group(1) = Temporal params
struct TemporalParams {
    jitterOffset: vec2<f32>,      // Current jitter offset (for reprojection correction)
    blendFactor: f32,             // Temporal blend (0.0 = full history, 1.0 = full current)
    clampFactor: f32,             // Neighborhood clamp strength (1.0 = full clamp)
}
@group(1) @binding(0) var<uniform> params: TemporalParams;

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
}

struct NeighborhoodMinMax {
    minColor: vec4<f32>,
    maxColor: vec4<f32>,
}

/**
 * Sample 3x3 neighborhood and compute min/max for color clamping
 */
fn computeNeighborhoodMinMax(uv: vec2<f32>) -> NeighborhoodMinMax {
    let texelSize = vec2<f32>(1.0) / vec2<f32>(textureDimensions(txCurrent));
    
    // Sample 3x3 neighborhood
    var minColor = vec4<f32>(1e10);
    var maxColor = vec4<f32>(-1e10);
    
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let neighborColor = textureSampleLevel(txCurrent, txSampler, uv + offset, 0.0);
            minColor = min(minColor, neighborColor);
            maxColor = max(maxColor, neighborColor);
        }
    }
    
    return NeighborhoodMinMax(minColor, maxColor);
}

/**
 * Clamp history color to neighborhood to reduce ghosting
 */
fn clampHistory(historyColor: vec4<f32>, minColor: vec4<f32>, maxColor: vec4<f32>) -> vec4<f32> {
    // Clamp each channel independently
    return clamp(historyColor, minColor, maxColor);
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = input.Uv;
    
    // 1. Sample current frame (SMAA 1x result)
    let currentColor = textureSample(txCurrent, txSampler, uv);
    
    // 2. Sample velocity (motion vector)
    let velocity = textureSample(txVelocity, txSampler, uv).xy;
    
    // 3. Compute history UV with velocity reprojection.
    // The velocity buffer is computed from jittered VP matrices, so it already
    // encodes the jitter difference between frames — no extra jitter correction needed.
    let historyUV = uv - velocity;
    
    // 4. Check if history UV is valid (inside screen bounds)
    let isHistoryValid = historyUV.x >= 0.0 && historyUV.x <= 1.0 && 
                         historyUV.y >= 0.0 && historyUV.y <= 1.0;
    
    // Early exit if history invalid (use current frame only)
    if (!isHistoryValid) {
        return currentColor;
    }
    
    // 5. Sample history
    let historyColor = textureSampleLevel(txHistory, txSampler, historyUV, 0.0);
    
    // 6. Compute neighborhood min/max for clamping
    let minMax = computeNeighborhoodMinMax(uv);
    
    // 7. Clamp history to neighborhood to reduce ghosting
    let clampedHistory = clampHistory(historyColor, minMax.minColor, minMax.maxColor);
    
    // 8. Temporal blend (mix current with clamped history)
    // blendFactor = 0.1 means 90% history, 10% current (high temporal stability)
    let finalColor = mix(clampedHistory, currentColor, params.blendFactor);
    
    return finalColor;
}
