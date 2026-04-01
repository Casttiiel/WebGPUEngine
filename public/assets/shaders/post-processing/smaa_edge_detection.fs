#include "common/uniforms"

// -----------------------------------------------------------------------------
// SMAA Edge Detection Pass (WGSL) — Accurate SMAA 1x Implementation
// Based on: "Enhanced Subpixel Morphological Antialiasing" - Jimenez et al.
// -----------------------------------------------------------------------------

struct SMAAParams {
    threshold: f32,  // 0.05–0.15 typical
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: SMAAParams;


// Edge detection function
fn colorEdgeDetection(uv: vec2<f32>, offset: array<vec4<f32>, 3>) -> vec2<f32> {
    let c = textureSample(colorTex, colorSampler, uv).rgb;

    // Neighbors
    let cL = textureSample(colorTex, colorSampler, offset[0].xy).rgb;
    var t = abs(c - cL);
    let deltaX = max(max(t.r, t.g), t.b);

    let cT = textureSample(colorTex, colorSampler, offset[0].zw).rgb;
    t = abs(c - cT);
    let deltaY = max(max(t.r, t.g), t.b);

    var edges = vec2<f32>(step(params.threshold, deltaX), step(params.threshold, deltaY));

    // Then discard if there is no edge:
    if (dot(edges, vec2<f32>(1.0)) == 0.0) {
        return vec2<f32>(0.0);
    }

    let cR = textureSampleLevel(colorTex, colorSampler, offset[1].xy, 0.0).rgb;
    t = abs(c - cR);
    var deltaZ = max(max(t.r, t.g), t.b);

    let cB = textureSampleLevel(colorTex, colorSampler, offset[1].zw, 0.0).rgb;
    t = abs(c - cB);
    var deltaW = max(max(t.r, t.g), t.b);

    // Calculate the maximum delta in the direct neighborhood:
    var maxDelta = max(vec2<f32>(deltaX, deltaY), vec2<f32>(deltaZ, deltaW));

    // Calculate left-left and top-top deltas:
    let cLL = textureSampleLevel(colorTex, colorSampler, offset[2].xy, 0.0).rgb;
    t = abs(c - cLL);
    deltaZ = max(max(t.r, t.g), t.b);

    let cTT = textureSampleLevel(colorTex, colorSampler, offset[2].zw, 0.0).rgb;
    t = abs(c - cTT);
    deltaW = max(max(t.r, t.g), t.b);

    // Calculate the final maximum delta:
    maxDelta = max(maxDelta.xy, vec2<f32>(deltaZ, deltaW));
    let finalDelta = max(maxDelta.x, maxDelta.y);

    // Local contrast adaptation (fixed factor 2.0 per SMAA spec):
    // Keep an edge only when its local delta is >= half the maximum neighbourhood delta.
    // This suppresses detector noise on low-contrast gradients while preserving real edges.
    edges = edges * step(vec2<f32>(finalDelta * 0.5), vec2<f32>(deltaX, deltaY));

    return edges;
}

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    // Calculate texel size
    let texelSize = 1.0 / camera.screenSize;
    
    // Calculate offsets in fragment shader
    var offset: array<vec4<f32>, 3>;
    
    // offset[0]: xy = left (-1,0), zw = top (0,-1)
    offset[0] = vec4<f32>(
        uv.x - texelSize.x, uv.y,
        uv.x, uv.y - texelSize.y
    );
    
    // offset[1]: xy = right (1,0), zw = bottom (0,1)
    offset[1] = vec4<f32>(
        uv.x + texelSize.x, uv.y,
        uv.x, uv.y + texelSize.y
    );
    
    // offset[2]: xy = far-left (-2,0), zw = far-top (0,-2)
    offset[2] = vec4<f32>(
        uv.x - 2.0 * texelSize.x, uv.y,
        uv.x, uv.y - 2.0 * texelSize.y
    );
    
    let edges = colorEdgeDetection(uv, offset);
    return vec4<f32>(edges.x, edges.y, 0.0, 1.0);
}