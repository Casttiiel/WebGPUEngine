// SMAA Blending Weight Calculation Fragment Shader
// Calculates blending weights based on edge patterns
// This is the second pass of the SMAA algorithm

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var edgesTex: texture_2d<f32>;
@group(1) @binding(1) var edgesSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// SMAA constants
const SMAA_MAX_SEARCH_STEPS: i32 = 16;
const SMAA_CORNER_ROUNDING: f32 = 0.25;

// Search for the end of an edge
fn searchLength(edge: vec2<f32>, texcoord: vec2<f32>, direction: vec2<f32>) -> f32 {
    let texSize = textureDimensions(edgesTex);
    let texelSize = 1.0 / vec2<f32>(texSize);
    
    var coord = texcoord;
    var length = 0.0;
    
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
        coord += direction * texelSize;
        let e = textureSample(edgesTex, edgesSampler, coord).rg;
        
        // Check if we found the edge end
        if (dot(e, edge) < 0.9) {
            break;
        }
        length += 1.0;
    }
    
    return length;
}

@fragment
fn main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texSize = textureDimensions(edgesTex);
    let texelSize = 1.0 / vec2<f32>(texSize);
    
    // Sample edge texture
    let edges = textureSample(edgesTex, edgesSampler, in.uv).rg;
    
    // If no edge, no blending needed
    if (dot(edges, vec2<f32>(1.0)) < 0.01) {
        return vec4<f32>(0.0);
    }
    
    var weights = vec4<f32>(0.0);
    
    // Horizontal edge
    if (edges.r > 0.5) {
        let leftLength = searchLength(vec2<f32>(1.0, 0.0), in.uv, vec2<f32>(-1.0, 0.0));
        let rightLength = searchLength(vec2<f32>(1.0, 0.0), in.uv, vec2<f32>(1.0, 0.0));
        
        // Calculate weights based on edge lengths
        let totalLength = leftLength + rightLength;
        if (totalLength > 0.0) {
            weights.x = leftLength / totalLength;
            weights.y = rightLength / totalLength;
        }
    }
    
    // Vertical edge
    if (edges.g > 0.5) {
        let topLength = searchLength(vec2<f32>(0.0, 1.0), in.uv, vec2<f32>(0.0, 1.0));
        let bottomLength = searchLength(vec2<f32>(0.0, 1.0), in.uv, vec2<f32>(0.0, -1.0));
        
        // Calculate weights based on edge lengths
        let totalLength = topLength + bottomLength;
        if (totalLength > 0.0) {
            weights.z = topLength / totalLength;
            weights.w = bottomLength / totalLength;
        }
    }
    
    // Apply corner rounding
    weights *= SMAA_CORNER_ROUNDING;
    
    return weights;
}
