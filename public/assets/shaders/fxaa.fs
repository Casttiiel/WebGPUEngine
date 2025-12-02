#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

// FXAA parameters - NVIDIA FXAA 3.11 Quality preset
const EDGE_THRESHOLD_MIN: f32 = 0.0312;  // Default quality (1/32)
const EDGE_THRESHOLD_MAX: f32 = 0.125;   // Default quality (1/8)
const SUBPIXEL_QUALITY: f32 = 0.75;      // Standard subpixel AA
const ITERATIONS: i32 = 12;              // Maximum quality iterations

fn rgb2luma(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fs(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let inverseScreenSize = 1.0 / camera.screenSize;
    
    // Sample center and neighbors
    let colorCenter = textureSampleLevel(inputTexture, inputSampler, texCoord, 0.0).rgb;
    let colorN = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(0.0, -inverseScreenSize.y), 0.0).rgb;
    let colorS = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(0.0, inverseScreenSize.y), 0.0).rgb;
    let colorE = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(inverseScreenSize.x, 0.0), 0.0).rgb;
    let colorW = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(-inverseScreenSize.x, 0.0), 0.0).rgb;
    
    // Convert to luma
    let lumaCenter = rgb2luma(colorCenter);
    let lumaN = rgb2luma(colorN);
    let lumaS = rgb2luma(colorS);
    let lumaE = rgb2luma(colorE);
    let lumaW = rgb2luma(colorW);
    
    // Find luma range
    let lumaMin = min(lumaCenter, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let lumaMax = max(lumaCenter, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let lumaRange = lumaMax - lumaMin;
    
    // Early exit if below threshold (no visible edge)
    if (lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX)) {
        return vec4<f32>(colorCenter, 1.0);
    }
    
    // Sample diagonal neighbors
    let colorNW = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(-inverseScreenSize.x, -inverseScreenSize.y), 0.0).rgb;
    let colorNE = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(inverseScreenSize.x, -inverseScreenSize.y), 0.0).rgb;
    let colorSW = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(-inverseScreenSize.x, inverseScreenSize.y), 0.0).rgb;
    let colorSE = textureSampleLevel(inputTexture, inputSampler, texCoord + vec2(inverseScreenSize.x, inverseScreenSize.y), 0.0).rgb;
    
    let lumaNW = rgb2luma(colorNW);
    let lumaNE = rgb2luma(colorNE);
    let lumaSW = rgb2luma(colorSW);
    let lumaSE = rgb2luma(colorSE);
    
    // Better edge detection with diagonal emphasis
    let lumaMinDiag = min(min(lumaNW, lumaNE), min(lumaSW, lumaSE));
    let lumaMaxDiag = max(max(lumaNW, lumaNE), max(lumaSW, lumaSE));
    let lumaRangeDiag = lumaMaxDiag - lumaMinDiag;
    
    // If diagonal range is significant, it's likely a real edge
    let diagonalFactor = clamp(lumaRangeDiag / max(lumaRange, 0.0001), 0.0, 1.0);
    
    // Determine edge direction
    let edgeHorizontal = 
        abs(-2.0 * lumaN + lumaNW + lumaNE) +
        abs(-2.0 * lumaCenter + lumaW + lumaE) * 2.0 +
        abs(-2.0 * lumaS + lumaSW + lumaSE);
    
    let edgeVertical = 
        abs(-2.0 * lumaW + lumaNW + lumaSW) +
        abs(-2.0 * lumaCenter + lumaN + lumaS) * 2.0 +
        abs(-2.0 * lumaE + lumaNE + lumaSE);
    
    let isHorizontal = edgeHorizontal >= edgeVertical;
    
    // Choose edge samples
    let luma1 = select(lumaW, lumaN, isHorizontal);
    let luma2 = select(lumaE, lumaS, isHorizontal);
    
    // Compute gradients
    let gradient1 = luma1 - lumaCenter;
    let gradient2 = luma2 - lumaCenter;
    
    // Determine steepest gradient
    let is1Steepest = abs(gradient1) >= abs(gradient2);
    // Reduced scaling for more sensitive edge detection
    let gradientScaled = 0.125 * max(abs(gradient1), abs(gradient2));
    
    // Compute step length in UV coordinates
    var stepLength = select(inverseScreenSize.y, inverseScreenSize.x, isHorizontal);
    
    // Choose edge direction
    var lumaLocalAverage = 0.0;
    if (is1Steepest) {
        stepLength *= -1.0;
        lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
    } else {
        lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
    }
    
    // Compute offset UV coordinates
    var currentUV = texCoord;
    if (isHorizontal) {
        currentUV.y += stepLength * 0.5;
    } else {
        currentUV.x += stepLength * 0.5;
    }
    
    // Compute UV offset
    var offset = select(vec2<f32>(0.0, inverseScreenSize.y), vec2<f32>(inverseScreenSize.x, 0.0), isHorizontal);
    
    // Edge search in both directions
    var uv1 = currentUV - offset;
    var uv2 = currentUV + offset;
    
    var lumaEnd1 = rgb2luma(textureSampleLevel(inputTexture, inputSampler, uv1, 0.0).rgb);
    var lumaEnd2 = rgb2luma(textureSampleLevel(inputTexture, inputSampler, uv2, 0.0).rgb);
    lumaEnd1 -= lumaLocalAverage;
    lumaEnd2 -= lumaLocalAverage;
    
    // Check if reached end of edge
    var reached1 = abs(lumaEnd1) >= gradientScaled;
    var reached2 = abs(lumaEnd2) >= gradientScaled;
    var reachedBoth = reached1 && reached2;
    
    // Continue search if not reached
    if (!reached1) {
        uv1 -= offset;
    }
    if (!reached2) {
        uv2 += offset;
    }
    
    // Extended edge search (12 iterations for maximum quality)
    if (!reachedBoth) {
        for (var i = 0; i < 12; i++) {
            if (!reached1) {
                lumaEnd1 = rgb2luma(textureSampleLevel(inputTexture, inputSampler, uv1, 0.0).rgb);
                lumaEnd1 -= lumaLocalAverage;
            }
            if (!reached2) {
                lumaEnd2 = rgb2luma(textureSampleLevel(inputTexture, inputSampler, uv2, 0.0).rgb);
                lumaEnd2 -= lumaLocalAverage;
            }
            reached1 = abs(lumaEnd1) >= gradientScaled;
            reached2 = abs(lumaEnd2) >= gradientScaled;
            reachedBoth = reached1 && reached2;
            
            // Adaptive step size: increases with iteration for faster convergence
            let stepMult = 1.5 + f32(i) * 0.5;
            if (!reached1) {
                uv1 -= offset * stepMult;
            }
            if (!reached2) {
                uv2 += offset * stepMult;
            }
            
            if (reachedBoth) {
                break;
            }
        }
    }
    
    // Compute distance to edge ends
    var distance1 = select(texCoord.y - uv1.y, texCoord.x - uv1.x, isHorizontal);
    var distance2 = select(uv2.y - texCoord.y, uv2.x - texCoord.x, isHorizontal);
    
    // Determine closest edge
    let isDirection1 = distance1 < distance2;
    let distanceFinal = min(distance1, distance2);
    
    // Compute edge length
    let edgeLength = distance1 + distance2;
    
    // Compute final UV offset
    let pixelOffset = -distanceFinal / edgeLength + 0.5;
    
    // Check if center is on darker side
    let isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
    
    // Check if reached correct edge end
    let correctVariation = (select(lumaEnd2, lumaEnd1, isDirection1) < 0.0) != isLumaCenterSmaller;
    
    // Compute final offset
    var finalOffset = select(0.0, pixelOffset, correctVariation);
    
    // Enhanced subpixel antialiasing with better perceptual curve
    let lumaAverage = (1.0/12.0) * (2.0 * (lumaN + lumaS + lumaE + lumaW) + lumaNW + lumaNE + lumaSW + lumaSE);
    let subPixelOffset1 = clamp(abs(lumaAverage - lumaCenter) / lumaRange, 0.0, 1.0);
    // Smoothstep for better perceptual quality
    let subPixelOffset2 = subPixelOffset1 * subPixelOffset1 * (3.0 - 2.0 * subPixelOffset1);
    let subPixelOffsetFinal = subPixelOffset2 * SUBPIXEL_QUALITY;
    
    // Choose max offset
    finalOffset = max(finalOffset, subPixelOffsetFinal);
    
    // Compute final UV
    var finalUV = texCoord;
    if (isHorizontal) {
        finalUV.y += finalOffset * stepLength;
    } else {
        finalUV.x += finalOffset * stepLength;
    }
    
    return vec4<f32>(textureSampleLevel(inputTexture, inputSampler, finalUV, 0.0).rgb, 1.0);
}