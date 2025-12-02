#include "common/uniforms"

// SMAA Edge Detection Fragment Shader (Pass 1)
// Basic SMAA algorithm: detects horizontal and vertical edges using luma differences

struct SMAAParams {
    edgeThreshold: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> smaaParams: SMAAParams;

// Calculate luma from RGB (Rec. 709 coefficients)
fn RGBToLuma(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    let texSize = textureDimensions(colorTex);
    let texelSize = 1.0 / vec2<f32>(texSize);
    
    // Sample only what we need: center, left, and top
    let colorC = textureSample(colorTex, colorSampler, uv).rgb;
    let colorL = textureSample(colorTex, colorSampler, uv + vec2<f32>(-texelSize.x, 0.0)).rgb;
    let colorT = textureSample(colorTex, colorSampler, uv + vec2<f32>(0.0, texelSize.y)).rgb;
    
    // Convert to luma
    let lumaC = RGBToLuma(colorC);
    let lumaL = RGBToLuma(colorL);
    let lumaT = RGBToLuma(colorT);
    
    // Calculate deltas
    let deltaH = abs(lumaC - lumaT);  // Horizontal edge (vertical change)
    let deltaV = abs(lumaC - lumaL);  // Vertical edge (horizontal change)
    
    // Optional: local contrast to avoid detecting noise/texture detail
    // Sample right and bottom for contrast calculation
    let colorR = textureSample(colorTex, colorSampler, uv + vec2<f32>(texelSize.x, 0.0)).rgb;
    let colorB = textureSample(colorTex, colorSampler, uv + vec2<f32>(0.0, -texelSize.y)).rgb;
    let lumaR = RGBToLuma(colorR);
    let lumaB = RGBToLuma(colorB);
    
    // Local contrast: max difference in 2x2 neighborhood
    let maxLuma = max(max(lumaC, lumaL), max(lumaT, max(lumaR, lumaB)));
    let minLuma = min(min(lumaC, lumaL), min(lumaT, min(lumaR, lumaB)));
    let localContrast = maxLuma - minLuma;
    
    // Use local contrast as additional threshold multiplier
    // This prevents detecting edges in very low-contrast areas (noise)
    let threshold = smaaParams.edgeThreshold;
    let contrastFactor = localContrast / max(maxLuma, 0.001); // Avoid division by zero
    
    // Only detect edges if there's sufficient local contrast
    let hasContrast = contrastFactor > 0.1; // 10% contrast minimum
    
    // Simple threshold comparison
    let edgeH = select(0.0, 1.0, hasContrast && (deltaH > threshold));
    let edgeV = select(0.0, 1.0, hasContrast && (deltaV > threshold));
    
    // Output: R = horizontal edge, G = vertical edge
    return vec4<f32>(edgeH, edgeV, 0.0, 1.0);
}
