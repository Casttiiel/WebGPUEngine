#include "common/uniforms"

// SMAA Neighborhood Blending Fragment Shader (Pass 3)
// Final pass: applies the blend weights calculated in Pass 2
// Does NOT invent weights, does NOT normalize - just applies what Pass 2 decided

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(2) @binding(0) var blendTex: texture_2d<f32>;
@group(2) @binding(1) var blendSampler: sampler;

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    let texSize = vec2<f32>(textureDimensions(colorTex));
    let texelSize = 1.0 / texSize;
    
    // Read blend weights from Pass 2
    // R = left weight, G = right weight, B = up weight, A = down weight
    let weights = textureSampleLevel(blendTex, blendSampler, uv, 0.0);
    
    // Early out: if no significant weights, return original color
    let totalWeight = weights.r + weights.g + weights.b + weights.a;
    if (totalWeight < 0.001) {
        return textureSampleLevel(colorTex, colorSampler, uv, 0.0);
    }
    
    // Sample original color
    let colorCenter = textureSampleLevel(colorTex, colorSampler, uv, 0.0);
    
    // === HORIZONTAL BLENDING ===
    var colorH = colorCenter;
    let hasHorizontal = (weights.r + weights.g) > 0.001;
    
    if (hasHorizontal) {
        // Sample left and right neighbors
        let colorLeft = textureSampleLevel(colorTex, colorSampler, uv + vec2<f32>(-texelSize.x, 0.0), 0.0);
        let colorRight = textureSampleLevel(colorTex, colorSampler, uv + vec2<f32>(texelSize.x, 0.0), 0.0);
        
        // Blend according to Pass 2 weights
        // If weights.r > weights.g, bias toward left
        // If weights.g > weights.r, bias toward right
        let totalH = weights.r + weights.g;
        let t = weights.g / totalH; // Interpolation factor [0,1]
        
        colorH = mix(colorLeft, colorRight, t);
    }
    
    // === VERTICAL BLENDING ===
    var colorV = colorCenter;
    let hasVertical = (weights.b + weights.a) > 0.001;
    
    if (hasVertical) {
        // Sample top and bottom neighbors
        let colorUp = textureSampleLevel(colorTex, colorSampler, uv + vec2<f32>(0.0, texelSize.y), 0.0);
        let colorDown = textureSampleLevel(colorTex, colorSampler, uv + vec2<f32>(0.0, -texelSize.y), 0.0);
        
        // Blend according to Pass 2 weights
        let totalV = weights.b + weights.a;
        let t = weights.a / totalV; // Interpolation factor [0,1]
        
        colorV = mix(colorUp, colorDown, t);
    }
    
    // === FINAL COMBINATION ===
    // If both H and V edges: combine them
    // If only one: use that one
    // The exact combination depends on edge strength
    
    if (hasHorizontal && hasVertical) {
        // Both edges present (corner/crossing)
        // Weight by total strength of each direction
        let strengthH = weights.r + weights.g;
        let strengthV = weights.b + weights.a;
        let totalStrength = strengthH + strengthV;
        
        // Blend between horizontal and vertical results
        let tCombine = strengthV / totalStrength;
        return mix(colorH, colorV, tCombine);
    }
    else if (hasHorizontal) {
        // Only horizontal edge
        let strengthH = weights.r + weights.g;
        return mix(colorCenter, colorH, strengthH);
    }
    else if (hasVertical) {
        // Only vertical edge
        let strengthV = weights.b + weights.a;
        return mix(colorCenter, colorV, strengthV);
    }
    
    // Fallback (shouldn't reach here due to early out)
    return colorCenter;
}
