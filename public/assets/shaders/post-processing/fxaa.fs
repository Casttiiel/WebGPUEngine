#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;

const SUBPIX: f32 = 0.75;
const EDGE_THRESHOLD: f32 = 0.166;
const EDGE_THRESHOLD_MIN: f32 = 0.0312;

// FXAA 3.11 Quality preset 12 — step distances per iteration
const QUALITY: array<f32, 12> = array<f32, 12>(
    1.0, 1.0, 1.0, 1.0,
    1.5, 1.5,
    2.0, 2.0,
    2.0, 2.0,
    4.0, 8.0
);

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

fn sampleLuma(uv: vec2<f32>) -> f32 {
    return luma(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb);
}

@fragment
fn fs(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let rcp = 1.0 / camera.screenSize;

    // --- Sample center + 4 cardinal neighbors ---
    let lumaM = sampleLuma(texCoord);
    let lumaN = sampleLuma(texCoord + vec2( 0.0,    -rcp.y));
    let lumaS = sampleLuma(texCoord + vec2( 0.0,     rcp.y));
    let lumaE = sampleLuma(texCoord + vec2( rcp.x,   0.0  ));
    let lumaW = sampleLuma(texCoord + vec2(-rcp.x,   0.0  ));

    let lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let lumaRange = lumaMax - lumaMin;

    // --- Early exit ---
    if (lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD)) {
        return textureSampleLevel(inputTexture, inputSampler, texCoord, 0.0);
    }

    // --- Sample diagonals for edge detection ---
    let lumaNW = sampleLuma(texCoord + vec2(-rcp.x, -rcp.y));
    let lumaNE = sampleLuma(texCoord + vec2( rcp.x, -rcp.y));
    let lumaSW = sampleLuma(texCoord + vec2(-rcp.x,  rcp.y));
    let lumaSE = sampleLuma(texCoord + vec2( rcp.x,  rcp.y));

    let edgeH =
        abs(lumaNW + lumaNE - 2.0 * lumaN) +
        abs(lumaSW + lumaSE - 2.0 * lumaS) +
        abs(lumaW  + lumaE  - 2.0 * lumaM);

    let edgeV =
        abs(lumaNW + lumaSW - 2.0 * lumaW) +
        abs(lumaNE + lumaSE - 2.0 * lumaE) +
        abs(lumaN  + lumaS  - 2.0 * lumaM);

    let horizontal = edgeH >= edgeV;

    // Search direction: along the edge
    var dir = vec2<f32>(0.0);
    if (horizontal) {
        dir = vec2<f32>(rcp.x, 0.0);
    } else {
        dir = vec2<f32>(0.0, rcp.y);
    }

    // Gradient on the correct perpendicular axis
    let gradient = select(
        max(abs(lumaW - lumaM), abs(lumaE - lumaM)),
        max(abs(lumaN - lumaM), abs(lumaS - lumaM)),
        horizontal
    );
    let gradientScaled = gradient * 0.25;

    // Local average on the perpendicular axis
    let lumaLocalAvg = select(
        0.5 * (lumaE + lumaW),
        0.5 * (lumaN + lumaS),
        horizontal
    );

    // Signed perpendicular step toward the steeper side of the edge
    var perpStep = 0.0;
    if (horizontal) {
        let stepDir = select(1.0, -1.0, abs(lumaN - lumaM) >= abs(lumaS - lumaM));
        perpStep = stepDir * rcp.y;
    } else {
        let stepDir = select(1.0, -1.0, abs(lumaW - lumaM) >= abs(lumaE - lumaM));
        perpStep = stepDir * rcp.x;
    }

    // Shift start position half a pixel toward the edge before searching
    var posB = texCoord;
    if (horizontal) {
        posB.y += perpStep * 0.5;
    } else {
        posB.x += perpStep * 0.5;
    }

    // --- Edge search (12 quality taps), storing luma as difference from local avg ---
    var posN = posB;
    var posP = posB;
    var lumaEndN = 0.0;
    var lumaEndP = 0.0;
    var doneN = false;
    var doneP = false;

    for (var i = 0; i < 12; i++) {
        if (!doneN) {
            posN -= dir * QUALITY[i];
            lumaEndN = sampleLuma(posN) - lumaLocalAvg;
            doneN = abs(lumaEndN) >= gradientScaled;
        }
        if (!doneP) {
            posP += dir * QUALITY[i];
            lumaEndP = sampleLuma(posP) - lumaLocalAvg;
            doneP = abs(lumaEndP) >= gradientScaled;
        }
        if (doneN && doneP) {
            break;
        }
    }

    // --- Distance to each edge end ---
    var distN: f32;
    var distP: f32;
    if (horizontal) {
        distN = texCoord.x - posN.x;
        distP = posP.x - texCoord.x;
    } else {
        distN = texCoord.y - posN.y;
        distP = posP.y - texCoord.y;
    }

    let spanLength = max(distN + distP, 1e-4);
    var pixelOffset = -min(distN, distP) / spanLength + 0.5;

    // Correct variation check: compare luma differences (can be negative) against 0
    let lumaMM = lumaM - lumaLocalAvg;
    let endSign = select(lumaEndP, lumaEndN, distN < distP);
    let correctVariation = (endSign < 0.0) != (lumaMM < 0.0);
    if (!correctVariation) {
        pixelOffset = 0.0;
    }

    // --- Subpixel AA ---
    let lumaAvg = (lumaN + lumaS + lumaE + lumaW) * 0.25;
    let subpix1 = clamp(abs(lumaAvg - lumaM) / max(lumaRange, 1e-4), 0.0, 1.0);
    let subpixOffset = subpix1 * subpix1 * SUBPIX;

    pixelOffset = max(pixelOffset, subpixOffset);

    // --- Apply offset perpendicular to the edge (correct axis) ---
    var finalUV = texCoord;
    if (horizontal) {
        finalUV.y += pixelOffset * perpStep;
    } else {
        finalUV.x += pixelOffset * perpStep;
    }

    return textureSampleLevel(inputTexture, inputSampler, finalUV, 0.0);
}