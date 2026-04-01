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

struct NeighborhoodStats {
    mean:   vec4<f32>,
    stddev: vec4<f32>,
}

/**
 * Sample 3x3 neighborhood and compute mean + stddev for variance-based AABB clamping.
 *
 * Variance clamp (Unreal-style):
 *   bounds = [mean - k*stddev, mean + k*stddev]
 *
 * Advantages over pure min/max AABB:
 *   - Flat areas → tight bounds → ghosts are rejected fast
 *   - Edge areas → wider bounds → avoids over-rejection / flickering
 *   - Reduces ghosting during headbob and camera movement
 */
fn computeNeighborhoodStats(uv: vec2<f32>) -> NeighborhoodStats {
    let texelSize = vec2<f32>(1.0) / vec2<f32>(textureDimensions(txCurrent));

    var mean = vec4<f32>(0.0);
    var m2   = vec4<f32>(0.0);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            let c = textureSampleLevel(txCurrent, txSampler, uv + offset, 0.0);
            mean += c;
            m2   += c * c;
        }
    }

    mean /= 9.0;
    let variance = max(m2 / 9.0 - mean * mean, vec4<f32>(0.0));
    let stddev   = sqrt(variance);

    return NeighborhoodStats(mean, stddev);
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
    
    // 6. Variance-based AABB neighborhood clamping
    //    k = 1.0 → clamp to [mean - 1σ, mean + 1σ]
    //    Tighter than pure min/max: flat areas reject ghosts faster,
    //    edge areas allow a little more leeway to avoid flicker.
    let stats  = computeNeighborhoodStats(uv);
    let gamma  = 1.0; // std-dev multiplier — lower = tighter = less ghosting
    let clampMin = stats.mean - gamma * stats.stddev;
    let clampMax = stats.mean + gamma * stats.stddev;
    let clampedHistory = clamp(historyColor, clampMin, clampMax);

    // 7. Adaptive blend factor based on motion magnitude.
    //    Static camera  → params.blendFactor (e.g. 0.1)  = 90% history → sharp temporal AA
    //    Moving/rotating → up to 0.3 = 70% history       → fast convergence, less ghosting
    //    This is the standard AAA approach (Unreal, Frostbite, etc.)
    let motionLength  = length(velocity);
    let adaptiveBlend = mix(params.blendFactor, 0.3, saturate(motionLength * 20.0));

    // 8. Temporal blend (mix current with clamped history)
    return mix(clampedHistory, currentColor, adaptiveBlend);
}
