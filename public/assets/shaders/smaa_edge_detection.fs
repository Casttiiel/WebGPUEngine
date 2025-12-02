// SMAA Edge Detection Fragment Shader
// Detects edges in the image using luma-based edge detection
// This is the first pass of the SMAA algorithm

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// SMAA threshold - controls edge detection sensitivity
const SMAA_THRESHOLD: f32 = 0.1;

// Calculate luma from RGB
fn RGBToLuma(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texSize = textureDimensions(colorTex);
    let texelSize = 1.0 / vec2<f32>(texSize);
    
    // Sample center and neighbors
    let colorCenter = textureSample(colorTex, colorSampler, in.uv).rgb;
    let colorLeft = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(-texelSize.x, 0.0)).rgb;
    let colorRight = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(texelSize.x, 0.0)).rgb;
    let colorTop = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(0.0, texelSize.y)).rgb;
    let colorBottom = textureSample(colorTex, colorSampler, in.uv + vec2<f32>(0.0, -texelSize.y)).rgb;
    
    // Convert to luma
    let lumaCenter = RGBToLuma(colorCenter);
    let lumaLeft = RGBToLuma(colorLeft);
    let lumaRight = RGBToLuma(colorRight);
    let lumaTop = RGBToLuma(colorTop);
    let lumaBottom = RGBToLuma(colorBottom);
    
    // Calculate deltas (edge detection)
    let deltaLeft = abs(lumaCenter - lumaLeft);
    let deltaRight = abs(lumaCenter - lumaRight);
    let deltaTop = abs(lumaCenter - lumaTop);
    let deltaBottom = abs(lumaCenter - lumaBottom);
    
    // Find maximum delta for horizontal and vertical edges
    let maxDeltaHorizontal = max(deltaLeft, deltaRight);
    let maxDeltaVertical = max(deltaTop, deltaBottom);
    
    // Detect edges
    let edgeHorizontal = step(SMAA_THRESHOLD, maxDeltaHorizontal);
    let edgeVertical = step(SMAA_THRESHOLD, maxDeltaVertical);
    
    // Output edges: R = horizontal, G = vertical
    return vec4<f32>(edgeHorizontal, edgeVertical, 0.0, 1.0);
}
