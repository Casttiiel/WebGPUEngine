// Auto Exposure - Adaptation Pass
// Reads the accumulated log-luminance sum from the previous compute pass,
// derives target exposure, and smoothly adapts the current exposure value
// using exponential smoothing (eye-adaptation simulation).

struct AdaptParams {
  dt:             f32,  // Delta time (seconds)
  adaptSpeedUp:   f32,  // Speed adapting TO bright  (iris closing — fast)
  adaptSpeedDown: f32,  // Speed adapting TO dark    (iris opening — slow)
  keyValue:       f32,  // Target mid-tone (0.18 = 18% grey)
  minExposure:    f32,  // Minimum exposure multiplier
  maxExposure:    f32,  // Maximum exposure multiplier
  compensation:   f32,  // EV compensation in stops (additive)
  _pad:           f32,
}

// accumulator[0] = sum of log-luminances scaled by 1000 (atomic i32, written by luminance pass)
@group(0) @binding(0) var<storage, read_write> accumulator: array<atomic<i32>>;

// exposureBuffer[0] = current adapted exposure (f32, read by tone_mapping shader)
@group(1) @binding(0) var<storage, read_write> exposureBuffer: array<f32>;

@group(2) @binding(0) var<uniform> params: AdaptParams;

const SCALE:         f32 = 1000.0;
const TOTAL_SAMPLES: f32 = 16384.0; // 256 workgroups × 64 threads

@compute @workgroup_size(1, 1, 1)
fn cs_adapt() {
  // --- Read accumulated log-luminance and reset for next frame ---
  let scaledSum = atomicLoad(&accumulator[0]);
  atomicStore(&accumulator[0], 0i);

  // --- Compute average log luminance across all samples ---
  let avgLogLum = f32(scaledSum) / (SCALE * TOTAL_SAMPLES);

  // Convert log-luminance back to linear, then apply EV compensation
  let avgLum = exp(avgLogLum) * exp2(params.compensation);

  // --- Target exposure: key / avgLum  (18% grey mapping) ---
  let targetExposure = clamp(
    params.keyValue / max(avgLum, 0.0001),
    params.minExposure,
    params.maxExposure,
  );

  // --- Temporal eye-adaptation (exponential smoothing) ---
  let prevExposure = exposureBuffer[0];
  // Adapt faster toward bright (iris closing), slower toward dark (iris opening)
  let adaptSpeed = select(params.adaptSpeedDown, params.adaptSpeedUp, targetExposure > prevExposure);
  let t = 1.0 - exp(-params.dt * adaptSpeed);
  exposureBuffer[0] = mix(prevExposure, targetExposure, t);
}
