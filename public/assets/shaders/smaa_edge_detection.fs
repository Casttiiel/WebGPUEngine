#include "common/uniforms"

// -----------------------------------------------------------------------------
// SMAA Edge Detection Pass (WGSL) — Accurate SMAA 1x Implementation
// Based on: "Enhanced Subpixel Morphological Antialiasing" - Jimenez et al.
// -----------------------------------------------------------------------------

struct SMAAParams {
    threshold: f32,           // 0.05–0.15 típico
    predicationStrength: f32, // 0.0–1.0 (0 = sin adaptativo, 0.5–1.0 = más adaptativo)
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: SMAAParams;

// SMAA parameters
const SMAA_THRESHOLD: f32 = 0.1;
const SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR: f32 = 2.0;

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

    var edges = vec2<f32>(step(SMAA_THRESHOLD,deltaX),step(SMAA_THRESHOLD,deltaY));

    if(dot(edges, vec2<f32>(1.0)) == 0.0){
        discard;
    }

    let cR = textureSample(colorTex, colorSampler, offset[1].xy).rgb;
    t = abs(c - cR);
    var deltaZ = max(max(t.r, t.g), t.b);

    let cB = textureSample(colorTex, colorSampler, offset[1].zw).rgb;
    t = abs(c - cB);
    var deltaW = max(max(t.r, t.g), t.b);

    // Calculate the maximum delta in the direct neighborhood:
    var maxDelta = max(vec2<f32>(deltaX, deltaY), vec2<f32>(deltaZ, deltaW));

    // Calculate left-left and top-top deltas:
    let cLL = textureSample(colorTex, colorSampler, offset[2].xy).rgb;
    t = abs(c - cLL);
    deltaZ = max(max(t.r, t.g), t.b);

    let cTT = textureSample(colorTex, colorSampler, offset[2].zw).rgb;
    t = abs(c - cTT);
    deltaW = max(max(t.r, t.g), t.b);

    maxDelta = max(maxDelta.xy, vec2<f32>(deltaZ, deltaW));
    let finalDelta = max(maxDelta.x, maxDelta.y);

    let contrast = step(vec2<f32>(finalDelta), SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR * vec2<f32>(deltaX, deltaY));
    edges = edges * contrast;

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