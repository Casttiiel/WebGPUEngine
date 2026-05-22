// Auto Exposure - Histogram Adaptation Pass
// Reads the 256-bin luminance histogram written by the luminance pass,
// trims the darkest and brightest percentiles (artist-controlled),
// derives average log-luminance from the remaining range, and writes
// a temporally smoothed exposure multiplier to exposureBuffer[0].
// Also resets the histogram bins for the next frame.

struct AdaptParams {
  dt:             f32,  // Delta time (seconds)
  adaptSpeedUp:   f32,  // Speed adapting toward bright (iris closing — fast)
  adaptSpeedDown: f32,  // Speed adapting toward dark   (iris opening — slow)
  keyValue:       f32,  // Target mid-tone (0.18 = 18% grey)
  minExposure:    f32,  // Minimum exposure multiplier
  maxExposure:    f32,  // Maximum exposure multiplier
  compensation:   f32,  // EV compensation in stops
  lowPercentile:  f32,  // Fraction of darkest pixels to discard  (e.g. 0.2)
  highPercentile: f32,  // Fraction of brightest pixels to keep   (e.g. 0.9)
  _pad1:          f32,
  _pad2:          f32,
  _pad3:          f32,
}

// histogram[i] = pixel count for log-lum bin i  (written by luminance pass)
@group(0) @binding(0) var<storage, read_write> histogram: array<atomic<i32>>;

// exposureBuffer[0] = current adapted exposure (read by tone_mapping shader)
@group(1) @binding(0) var<storage, read_write> exposureBuffer: array<f32>;

@group(2) @binding(0) var<uniform> params: AdaptParams;

const TOTAL_SAMPLES: f32 = 16384.0; // 16×16 dispatch × 8×8 workgroup
const MIN_LOG_LUM:   f32 = -10.0;
const MAX_LOG_LUM:   f32 =  4.0;

@compute @workgroup_size(1, 1, 1)
fn cs_adapt() {
  let totalPixels = i32(TOTAL_SAMPLES);
  let lowCut  = i32(f32(totalPixels) * params.lowPercentile);
  let highCut = i32(f32(totalPixels) * params.highPercentile);

  var count        = 0i;
  var logSum       = 0.0;
  var validSamples = 0i;

  // Walk all 256 bins, accumulate log-lum for the [lowCut, highCut) range,
  // and reset each bin for the next frame in the same pass.
  for (var i = 0u; i < 256u; i++) {
    let binCount = atomicLoad(&histogram[i]);
    atomicStore(&histogram[i], 0i); // reset for next frame

    // Reconstruct the log-lum at the centre of this bin
    let t      = (f32(i) + 0.5) / 256.0;
    let logLum = mix(MIN_LOG_LUM, MAX_LOG_LUM, t);

    // Iterate over every pixel in this bin and decide if it falls in range.
    // Total iterations across all bins == TOTAL_SAMPLES (≤ 16 384) — fast.
    for (var j = 0i; j < binCount; j++) {
      count++;
      if (count > lowCut && count <= highCut) {
        logSum += logLum;
        validSamples++;
      }
    }
  }

  // Average log-lum of the trimmed range → linear lum → apply EV compensation
  let avgLogLum = logSum / max(f32(validSamples), 1.0);
  let avgLum    = exp(avgLogLum) * exp2(params.compensation);

  // --- Target exposure ---
  let targetExposure = clamp(
    params.keyValue / max(avgLum, 0.0001),
    params.minExposure,
    params.maxExposure,
  );

  // --- Temporal eye-adaptation (exponential smoothing) ---
  let prevExposure = exposureBuffer[0];
  let adaptSpeed   = select(params.adaptSpeedDown, params.adaptSpeedUp, targetExposure > prevExposure);
  let blend        = 1.0 - exp(-params.dt * adaptSpeed);
  exposureBuffer[0] = mix(prevExposure, targetExposure, blend);
}
