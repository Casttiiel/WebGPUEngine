#include "common/uniforms"

// -----------------------------------------------------------------------------
// SMAA 1x Blending Weight Calculation (Pass 2)
// WebGPU / WGSL Implementation
// Complete reference implementation with all helper functions
// -----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var edgesTex: texture_2d<f32>;
@group(1) @binding(1) var edgesSampler: sampler;
@group(1) @binding(2) var areaTex: texture_2d<f32>;
@group(1) @binding(3) var areaSampler: sampler;
@group(1) @binding(4) var searchTex: texture_2d<f32>;
@group(1) @binding(5) var searchSampler: sampler;

struct SMAABlendParams {
    maxSearchSteps: f32,
    maxSearchStepsDiag: f32,
    cornerRounding: f32,
    disableDiagDetection: f32,
    useDirectWeights: f32,
}

@group(2) @binding(0) var<uniform> blendParams: SMAABlendParams;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Dynamic parameters from uniform buffer (overwrite constants if needed)
// These are accessed via blendParams.* in the shader

// SMAA configuration constants - Static values (texture properties)
const SMAA_AREATEX_MAX_DISTANCE: f32 = 16.0;
const SMAA_AREATEX_MAX_DISTANCE_DIAG: f32 = 20.0;
const SMAA_AREATEX_PIXEL_SIZE: vec2<f32> = vec2(1.0/160.0, 1.0/560.0);
const SMAA_AREATEX_SUBTEX_SIZE: f32 = 1.0 / 7.0;
const SMAA_SEARCHTEX_SIZE: vec2<f32> = vec2(64.0, 16.0);        // Must match actual texture dimensions
const SMAA_SEARCHTEX_PACKED_SIZE: vec2<f32> = vec2(64.0, 16.0); // Same as SIZE for this texture

// Include all SMAA helper functions
#include "post-processing/smaa_diagonal_helpers"

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    // Calculate texel size and pixel coordinates
    let texelSize = 1.0 / camera.screenSize;
    let pixCoord = uv * camera.screenSize;
    
    // Calculate offsets (CROSSING_OFFSET = -0.25 * texelSize)
    // vOffset[0] = mad(vec4(-0.25, -0.125, 1.25, -0.125), texelSize.xyxy, uv.xyxy)
    // vOffset[1] = mad(vec4(-0.125, -0.25, -0.125, 1.25), texelSize.xyxy, uv.xyxy)
    // vOffset[2] = mad(vec4(-2.0, 2.0, -2.0, 2.0) * maxSearchSteps, texelSize.xxyy, vOffset[0].xz + vOffset[1].yw)
    var vOffset: array<vec4<f32>, 3>;
    vOffset[0] = mad_vec4(vec4<f32>(-0.25, -0.125, 1.25, -0.125), vec4<f32>(texelSize, texelSize), vec4<f32>(uv, uv));
    vOffset[1] = mad_vec4(vec4<f32>(-0.125, -0.25, -0.125, 1.25), vec4<f32>(texelSize, texelSize), vec4<f32>(uv, uv));
    // CRITICAL: Multiply by maxSearchSteps to set proper search boundaries
    vOffset[2] = mad_vec4(
        vec4<f32>(-2.0, 2.0, -2.0, 2.0) * blendParams.maxSearchSteps,
        vec4<f32>(texelSize.x, texelSize.x, texelSize.y, texelSize.y),
        vec4<f32>(vOffset[0].x, vOffset[0].z, vOffset[1].y, vOffset[1].w)
    );
    
    let subsampleIndices = vec4<f32>(0.0); // Just pass zero for SMAA 1x
    var weights = vec4<f32>(0.0);
    var e = textureSampleLevel(edgesTex, edgesSampler, uv, 0.0).rg;
    
    if (e.g > 0.0) { // Edge at north
        
        // DIAGONAL DETECTION (if enabled)
        // Diagonals have both north and west edges, so searching for them in
        // one of the boundaries is enough.
        if (blendParams.disableDiagDetection < 0.5) {
            weights = vec4<f32>(SMAACalculateDiagWeights(edgesTex, edgesSampler, areaTex, areaSampler, uv, e, subsampleIndices, texelSize), 0.0, 0.0);
        }
        
        // We give priority to diagonals, so if we find a diagonal we skip
        // horizontal/vertical processing.
        // The condition checks if weights.r + weights.g == 0.0 (no diagonal found)
        let noDiagonalFound = blendParams.disableDiagDetection > 0.5 || abs(weights.r + weights.g) < 0.0001;
        
        if (noDiagonalFound) {
            var d: vec2<f32>;
            
            // Find the distance to the left:
            var coords: vec3<f32>;
            coords.x = SMAASearchXLeft(edgesTex, edgesSampler, searchTex, searchSampler, vOffset[0].xy, vOffset[2].x, texelSize);
            coords.y = vOffset[1].y; // vOffset[1].y = uv.y - 0.25 * texelSize.y (@CROSSING_OFFSET)
            d.x = coords.x;
            
            // Now fetch the left crossing edges, two at a time using bilinear
            // filtering. Sampling at -0.25 (see @CROSSING_OFFSET) enables to
            // discern what value each edge has:
            let e1 = textureSampleLevel(edgesTex, edgesSampler, coords.xy, 0.0).r;
            
            // Find the distance to the right:
            coords.z = SMAASearchXRight(edgesTex, edgesSampler, searchTex, searchSampler, vOffset[0].zw, vOffset[2].y, texelSize);
            d.y = coords.z;
            
            // We want the distances to be in pixel units (doing this here allow to
            // better interleave arithmetic and memory accesses):
            d = abs(round(mad_vec2(camera.screenSize.xx, d, -pixCoord.xx)));
            
            // Clamp distances to valid range for area texture lookup
            d = clamp(d, vec2<f32>(0.0), vec2<f32>(SMAA_AREATEX_MAX_DISTANCE));
            
            // SMAAArea below needs a sqrt, as the areas texture is compressed
            // quadratically:
            let sqrt_d = sqrt(d);
            
            // Fetch the right crossing edges:
            let e2 = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.zy, vec2<i32>(1, 0), texelSize).r;
            
            // Ok, we know how this pattern looks like, now it is time for getting
            // the actual area:
            if (blendParams.useDirectWeights > 0.5) {
                // Direct weight calculation: longer edges = stronger antialiasing
                // Maximum weight when edge extends full search distance
                let maxDist = SMAA_AREATEX_MAX_DISTANCE;
                weights.r = clamp((d.x / maxDist) * (e1 * 0.5 + 0.5), 0.0, 1.0);
                weights.g = clamp((d.y / maxDist) * (e2 * 0.5 + 0.5), 0.0, 1.0);
            } else {
                let areaWeights = SMAAArea(areaTex, areaSampler, sqrt_d, e1, e2, subsampleIndices.y);
                weights.r = areaWeights.x;
                weights.g = areaWeights.y;
            }
            
            // Fix corners:
            coords.y = uv.y;
            var weightsRG = vec2<f32>(weights.r, weights.g);
            SMAADetectHorizontalCornerPattern(edgesTex, edgesSampler, &weightsRG, coords.xyzy, d, texelSize);
            weights.r = weightsRG.x;
            weights.g = weightsRG.y;
        
        } else {
            // Diagonal found, skip vertical processing
            e.r = 0.0;
        }
    }
    
    if (e.r > 0.0) { // Edge at west
        var d: vec2<f32>;
        
        // Find the distance to the top:
        var coords: vec3<f32>;
        coords.y = SMAASearchYUp(edgesTex, edgesSampler, searchTex, searchSampler, vOffset[1].xy, vOffset[2].z, texelSize);
        coords.x = vOffset[0].x; // vOffset[1].x = uv.x - 0.25 * texelSize.x;
        d.x = coords.y;
        
        // Fetch the top crossing edges:
        let e1 = textureSampleLevel(edgesTex, edgesSampler, coords.xy, 0.0).g;
        
        // Find the distance to the bottom:
        coords.z = SMAASearchYDown(edgesTex, edgesSampler, searchTex, searchSampler, vOffset[1].zw, vOffset[2].w, texelSize);
        d.y = coords.z;
        
        // We want the distances to be in pixel units:
        d = abs(round(mad_vec2(camera.screenSize.yy, d, -pixCoord.yy)));
        
        // Clamp distances to valid range
        d = clamp(d, vec2<f32>(0.0), vec2<f32>(SMAA_AREATEX_MAX_DISTANCE));
        
        // SMAAArea below needs a sqrt, as the areas texture is compressed
        // quadratically:
        let sqrt_d = sqrt(d);
        
        // Fetch the bottom crossing edges:
        let e2 = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.xz, vec2<i32>(0, 1), texelSize).g;
        
        // Get the area for this direction:
        if (blendParams.useDirectWeights > 0.5) {
            // Direct weight calculation for vertical edges
            let maxDist = SMAA_AREATEX_MAX_DISTANCE;
            weights.b = clamp((d.x / maxDist) * (e1 * 0.5 + 0.5), 0.0, 1.0);
            weights.a = clamp((d.y / maxDist) * (e2 * 0.5 + 0.5), 0.0, 1.0);
        } else {
            let areaWeights = SMAAArea(areaTex, areaSampler, sqrt_d, e1, e2, subsampleIndices.x);
            weights.b = areaWeights.x;
            weights.a = areaWeights.y;
        }
        
        // Fix corners:
        coords.x = uv.x;
        var weightsBA = vec2<f32>(weights.b, weights.a);
        SMAADetectVerticalCornerPattern(edgesTex, edgesSampler, &weightsBA, coords.xyxz, d, texelSize);
        weights.b = weightsBA.x;
        weights.a = weightsBA.y;
    }
    
    return weights;
}