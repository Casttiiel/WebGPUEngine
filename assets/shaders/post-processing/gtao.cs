#include "common/uniforms"
#include "common/core/constants"
#include "common/octahedral"
#include "post-processing/ao_common"

// ---------------------------------------------------------------------------
// Ground-Truth Ambient Occlusion — compute shader
// Faithful port of three.js GTAONode (examples/jsm/tsl/display/GTAONode.js),
// based on the Activision GTAO paper (Jimenez et al. 2016).
//
// No spatial denoise: the per-frame slice rotation / step jitter (temporalDirection,
// temporalOffset) is meant to be resolved by a temporal AA pass (TAA/TSR).
// Workgroup 8×8 → one thread per AO-resolution pixel.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(1) var gNormals:       texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var<uniform> params: AOParams;

@group(3) @binding(0) var outputAO: texture_storage_2d<rgba16float, write>;

// 5×5 magic square (three.js generateMagicSquareNoise(5)), sampled nearest + repeat.
// Each entry k maps to the rotation angle 2π·k/25.
fn magicSquare(idx: u32) -> f32 {
    let m = array<f32, 25>(
         9.0,  3.0, 22.0, 16.0, 15.0,
         2.0, 21.0, 20.0, 14.0,  8.0,
        25.0, 19.0, 13.0,  7.0,  1.0,
        18.0, 12.0,  6.0,  5.0, 24.0,
        11.0, 10.0,  4.0, 23.0, 17.0,
    );
    return m[idx];
}

// Sidestep the nearest-rounding of the unjittered center pixel at reduced resolution:
// take the closest of the 2×2 full-res texels under this AO pixel (avoids banding).
fn sampleCenterDepth(uv: vec2<f32>) -> f32 {
    let g = textureGather(0, gLinearDepth, samplerGBuffer, uv);
    return min(min(g.x, g.y), min(g.z, g.w));
}

fn safeAcos(x: f32) -> f32 {
    return acos(clamp(x, -1.0, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dstSize = vec2<i32>(textureDimensions(outputAO));
    let coords  = vec2<i32>(global_id.xy);
    if (coords.x >= dstSize.x || coords.y >= dstSize.y) { return; }

    let resolution       = vec2<f32>(dstSize);
    let screenCoordinate = vec2<f32>(coords) + 0.5;
    let uv               = screenCoordinate / resolution;

    let depth = select(aoSampleDepth(uv), sampleCenterDepth(uv), params.resolutionScale < 1.0);
    if (depth >= 1.0) {
        textureStore(outputAO, coords, aoPack(1.0)); // background: no occlusion
        return;
    }

    let viewPosition = aoGetViewPosition(uv, depth);
    let viewNormal   = aoGetViewNormal(uv);

    let radius    = params.radius;
    let invRadius = 1.0 / radius;
    let viewDir   = normalize(-viewPosition);

    let clipPosition = camera.projectionMatrix * vec4<f32>(viewPosition, 1.0);

    // Per-pixel kernel rotation from the 5×5 magic-square noise (noiseUv = (u, 1 - v) · res / 5)
    let noisePx    = vec2<i32>(floor(vec2<f32>(uv.x, 1.0 - uv.y) * resolution));
    let noiseIdx   = u32(noisePx.y % 5) * 5u + u32(noisePx.x % 5);
    let noiseAngle = TWO_PI * magicSquare(noiseIdx) / 25.0;
    let tangent    = vec3<f32>(cos(noiseAngle), sin(noiseAngle), 0.0);
    let bitangent  = vec3<f32>(-tangent.y, tangent.x, 0.0);

    let samples    = i32(params.samples);
    let directions = select(5, 3, samples < 30);
    let steps      = (samples + directions - 1) / directions; // ceil(samples / directions)
    let invSteps   = 1.0 / f32(steps);

    // Per-step phase jitter for spatio-temporal decorrelation.
    let noiseJitterIdx = params.temporalDirection * 0.02;
    let stepJitter = aoInterleavedGradientNoise(screenCoordinate + params.temporalOffset)
                   + aoRand((uv + noiseJitterIdx) * 2.0 - 1.0);

    var ao = 0.0;

    // Each iteration analyzes one vertical "slice" of the 3D space around the fragment.
    for (var i = 0; i < directions; i++) {
        let angle     = f32(i) / f32(directions) * PI + params.temporalDirection;
        let sampleDir = tangent * cos(angle) + bitangent * sin(angle);
        let clipDirRadius = (camera.projectionMatrix * vec4<f32>(sampleDir, 0.0)) * radius;

        let sliceBitangent = normalize(cross(sampleDir, viewDir));
        let sliceTangent   = cross(sliceBitangent, viewDir);

        // Project the view normal onto the slice plane. The unnormalized length is the
        // foreshortening weight applied at slice integration (paper §3.2).
        let projNRaw = viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent);
        let projNLen = length(projNRaw);
        let projN    = projNRaw / max(projNLen, 0.0001);

        // γ — angle of projN within the slice plane, signed by the tangent direction.
        let nSin   = dot(projN, sliceTangent);
        let nCos   = clamp(dot(projN, viewDir), 0.0, 1.0);
        let angleN = select(-1.0, 1.0, nSin >= 0.0) * acos(nCos);

        let tangentToNormalInSlice = cross(projN, sliceBitangent);
        let cosHorizon = dot(viewDir, tangentToNormalInSlice);
        var cosHorizons = vec2<f32>(cosHorizon, -cosHorizon);

        // Ray-march both directions along the slice to find the horizons.
        for (var j = 0; j < steps; j++) {
            // Quadratic step distribution (t²) concentrates samples in the near field.
            let t          = (f32(j) + 1.0 + stepJitter) * invSteps;
            let sampleDist = t * t;
            let clipOffset = clipDirRadius * sampleDist;

            // +sampleDir
            let uvX     = aoGetScreenPositionFromClip(clipPosition + clipOffset);
            let posX    = aoGetViewPosition(uvX, aoSampleDepth(uvX));
            let deltaX  = posX - viewPosition;
            let lenX    = length(deltaX);
            let sHX     = dot(viewDir, deltaX) / max(lenX, 0.0001);
            // Sphere falloff: (dist / radius)² fades the contribution near the radius (paper §4.3).
            let distFacX = min(lenX * invRadius, 1.0);
            if (abs(deltaX.z) < params.thickness) {
                cosHorizons.x = mix(max(cosHorizons.x, sHX), cosHorizons.x, distFacX * distFacX);
            }

            // -sampleDir
            let uvY     = aoGetScreenPositionFromClip(clipPosition - clipOffset);
            let posY    = aoGetViewPosition(uvY, aoSampleDepth(uvY));
            let deltaY  = posY - viewPosition;
            let lenY    = length(deltaY);
            let sHY     = dot(viewDir, deltaY) / max(lenY, 0.0001);
            let distFacY = min(lenY * invRadius, 1.0);
            if (abs(deltaY.z) < params.thickness) {
                cosHorizons.y = mix(max(cosHorizons.y, sHY), cosHorizons.y, distFacY * distFacY);
            }
        }

        // Cosine-weighted inner integral, closed form (paper Eq. 7):
        //   term_i = −cos(2h_i − γ) + cos(γ) + 2h_i·sin(γ)
        // 0.25 = ½ (integral normalization) × ½ (average of both horizons).
        // sliceTangent points opposite to sampleDir, so the +sampleDir horizon (x) is on
        // the −T side and hPos must read from cosHorizons.y.
        let hPos    = safeAcos(cosHorizons.y);
        let hNeg    = -safeAcos(cosHorizons.x);
        let termPos = -cos(hPos * 2.0 - angleN) + nCos + hPos * 2.0 * nSin;
        let termNeg = -cos(hNeg * 2.0 - angleN) + nCos + hNeg * 2.0 * nSin;
        let a = (termPos + termNeg) * 0.25;

        ao += projNLen * a;
    }

    ao = clamp(ao / f32(directions), 0.0, 1.0);
    ao = pow(ao, params.scale);

    textureStore(outputAO, coords, aoPack(ao));
}
