// GI debug view → accLight (RealtimeGI.renderDebugOverlay), replacing the lit frame.

@group(0) @binding(0) var debugTex: texture_2d<f32>;
@group(0) @binding(1) var debugSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(textureSampleLevel(debugTex, debugSampler, uv, 0.0).rgb, 1.0);
}
