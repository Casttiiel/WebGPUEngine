#include "common/uniforms"

// SMAA Blending Weight Calculation Fragment Shader (Pass 2)
// This is the brain of SMAA - calculates precise blend weights based on edge patterns
// Simplified version without searchTex/areaTex LUTs (those require offline generation)

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var edgesTex: texture_2d<f32>;
@group(1) @binding(1) var edgesSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// SMAA configuration
const SMAA_MAX_SEARCH_STEPS: i32 = 32; // Increased for better quality
const SMAA_MAX_SEARCH_STEPS_DIAG: i32 = 16;

// Bilinear search for edge end with subpixel precision
fn searchXLeft(texcoord: vec2<f32>, end: f32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(edgesTex));
    let texelSize = 1.0 / texSize;
    
    var offset = vec2<f32>(0.0);
    
    // Linear search along horizontal scanline
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
        offset.x -= texelSize.x;
        
        // Sample edges
        let e = textureSampleLevel(edgesTex, edgesSampler, texcoord + offset, 0.0).rg;
        
        // Check if edge ended (no more horizontal edge)
        if (e.r < 0.9 || offset.x < -end) {
            break;
        }
    }
    
    return max(offset.x, -end);
}

fn searchXRight(texcoord: vec2<f32>, end: f32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(edgesTex));
    let texelSize = 1.0 / texSize;
    
    var offset = vec2<f32>(0.0);
    
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
        offset.x += texelSize.x;
        
        let e = textureSampleLevel(edgesTex, edgesSampler, texcoord + offset, 0.0).rg;
        
        if (e.r < 0.9 || offset.x > end) {
            break;
        }
    }
    
    return min(offset.x, end);
}

fn searchYUp(texcoord: vec2<f32>, end: f32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(edgesTex));
    let texelSize = 1.0 / texSize;
    
    var offset = vec2<f32>(0.0);
    
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
        offset.y += texelSize.y;
        
        let e = textureSampleLevel(edgesTex, edgesSampler, texcoord + offset, 0.0).rg;
        
        if (e.g < 0.9 || offset.y > end) {
            break;
        }
    }
    
    return min(offset.y, end);
}

fn searchYDown(texcoord: vec2<f32>, end: f32) -> f32 {
    let texSize = vec2<f32>(textureDimensions(edgesTex));
    let texelSize = 1.0 / texSize;
    
    var offset = vec2<f32>(0.0);
    
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
        offset.y -= texelSize.y;
        
        let e = textureSampleLevel(edgesTex, edgesSampler, texcoord + offset, 0.0).rg;
        
        if (e.g < 0.9 || offset.y < -end) {
            break;
        }
    }
    
    return max(offset.y, -end);
}

// Calculate blend weights based on edge lengths
// This is a simplified area calculation without the precomputed LUT
fn calculateHorizontalWeights(left: f32, right: f32, texelSize: vec2<f32>) -> vec2<f32> {
    // Convert offsets to pixel lengths
    let leftLen = abs(left) / texelSize.x;
    let rightLen = abs(right) / texelSize.x;
    let totalLen = leftLen + rightLen;
    
    if (totalLen < 0.5) {
        return vec2<f32>(0.0);
    }
    
    // Weight calculation based on edge pattern
    // Longer edges get stronger blending
    let edgeFactor = min(totalLen / 8.0, 1.0); // Normalize to [0,1]
    
    // Asymmetric edges: favor the longer side slightly
    let balance = leftLen / totalLen;
    let leftWeight = balance * edgeFactor;
    let rightWeight = (1.0 - balance) * edgeFactor;
    
    return vec2<f32>(leftWeight, rightWeight);
}

fn calculateVerticalWeights(up: f32, down: f32, texelSize: vec2<f32>) -> vec2<f32> {
    let upLen = abs(up) / texelSize.y;
    let downLen = abs(down) / texelSize.y;
    let totalLen = upLen + downLen;
    
    if (totalLen < 0.5) {
        return vec2<f32>(0.0);
    }
    
    let edgeFactor = min(totalLen / 8.0, 1.0);
    let balance = upLen / totalLen;
    let upWeight = balance * edgeFactor;
    let downWeight = (1.0 - balance) * edgeFactor;
    
    return vec2<f32>(upWeight, downWeight);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    let texSize = vec2<f32>(textureDimensions(edgesTex));
    let texelSize = 1.0 / texSize;
    
    // Sample edges at this pixel
    let edges = textureSampleLevel(edgesTex, edgesSampler, uv, 0.0).rg;
    
    // Early out if no edges
    if (edges.r < 0.1 && edges.g < 0.1) {
        return vec4<f32>(0.0);
    }
    
    var weights = vec4<f32>(0.0);
    
    // Maximum search distance (in texture coordinates)
    let maxSearchDistance = f32(SMAA_MAX_SEARCH_STEPS) * texelSize.x;
    
    // === HORIZONTAL EDGE (R channel) ===
    if (edges.r > 0.9) {
        // Search left and right for edge ends
        let left = searchXLeft(uv, maxSearchDistance);
        let right = searchXRight(uv, maxSearchDistance);
        
        // Calculate blend weights for this horizontal edge
        let horizontalWeights = calculateHorizontalWeights(left, right, texelSize);
        
        // Store in RG channels (for horizontal blending in pass 3)
        weights.r = horizontalWeights.x; // Left blend weight
        weights.g = horizontalWeights.y; // Right blend weight
    }
    
    // === VERTICAL EDGE (G channel) ===
    if (edges.g > 0.9) {
        // Search up and down for edge ends
        let up = searchYUp(uv, maxSearchDistance);
        let down = searchYDown(uv, maxSearchDistance);
        
        // Calculate blend weights for this vertical edge
        let verticalWeights = calculateVerticalWeights(up, down, texelSize);
        
        // Store in BA channels (for vertical blending in pass 3)
        weights.b = verticalWeights.x; // Up blend weight
        weights.a = verticalWeights.y; // Down blend weight
    }
    
    return weights;
}
