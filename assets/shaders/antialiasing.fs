#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gAlbedoSampler: sampler;

const FXAA_EDGE_THRESHOLD : f32 = 1.0 / 8.0;
const FXAA_EDGE_THRESHOLD_MIN : f32 = 1.0 / 24.0;
const FXAA_SUBPIX_TRIM : f32 = 1.0 / 4.0;
const FXAA_SUBPIX_TRIM_SCALE : f32 = 1.0 / (1.0 - FXAA_SUBPIX_TRIM);
const FXAA_SUBPIX_CAP : f32 = 3.0 / 4.0;

 fn luma(color: vec3<f32>) -> f32 {
        return color.y * (0.587 / 0.299) + color.x;
    };


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rcpFrame = 1.0 / camera.sourceSize;

        // === Sample all neighbors up front ===
    let colM = textureSample(gAlbedo, gAlbedoSampler, uv).rgb;
    let colN = textureSample(gAlbedo, gAlbedoSampler, uv + vec2(0.0, -rcpFrame.y)).rgb;
    let colS = textureSample(gAlbedo, gAlbedoSampler, uv + vec2(0.0,  rcpFrame.y)).rgb;
    let colE = textureSample(gAlbedo, gAlbedoSampler, uv + vec2( rcpFrame.x, 0.0)).rgb;
    let colW = textureSample(gAlbedo, gAlbedoSampler, uv + vec2(-rcpFrame.x, 0.0)).rgb;

    let colNW = textureSample(gAlbedo, gAlbedoSampler, uv + vec2(-rcpFrame.x, -rcpFrame.y)).rgb;
    let colNE = textureSample(gAlbedo, gAlbedoSampler, uv + vec2( rcpFrame.x, -rcpFrame.y)).rgb;
    let colSW = textureSample(gAlbedo, gAlbedoSampler, uv + vec2(-rcpFrame.x,  rcpFrame.y)).rgb;
    let colSE = textureSample(gAlbedo, gAlbedoSampler, uv + vec2( rcpFrame.x,  rcpFrame.y)).rgb;

    // === Compute luma values ===
    let lumaM = luma(colM);
    let lumaN = luma(colN);
    let lumaS = luma(colS);
    let lumaE = luma(colE);
    let lumaW = luma(colW);

    let rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let range = rangeMax - rangeMin;

    // === Calculate blend amount unconditionally ===
    let lumaAvg = (lumaN + lumaS + lumaE + lumaW) * 0.25;
    let rangeL = abs(lumaAvg - lumaM);
    var blendL = max(0.0, (rangeL / range) - FXAA_SUBPIX_TRIM) * FXAA_SUBPIX_TRIM_SCALE;
    blendL = min(FXAA_SUBPIX_CAP, blendL);

    // === Average 3x3 region ===
    let blurred = (
        colM + colN + colS + colE + colW +
        colNW + colNE + colSW + colSE
    ) / 9.0;

    // === Skip blend if contrast is too low ===
    let isEdge = range >= max(FXAA_EDGE_THRESHOLD_MIN, rangeMax * FXAA_EDGE_THRESHOLD);
    let finalColor = select(colM, mix(blurred, colM, blendL), isEdge);

    return vec4<f32>(finalColor, 1.0);
}