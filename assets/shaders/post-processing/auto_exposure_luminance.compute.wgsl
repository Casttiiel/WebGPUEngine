// Auto Exposure - Luminance Histogram Pass
// Samples 128×128 = 16 384 points from the HDR scene texture.
// Each thread maps its pixel luminance to one of 256 log-space bins
// and atomically increments that bin. No workgroup reduction needed.

@group(0) @binding(0) var hdrTexture: texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;

// histogram[i] = number of pixels that fell in bin i  (atomic i32)
@group(1) @binding(0) var<storage, read_write> histogram: array<atomic<i32>>;

const SAMPLE_DIM:  f32 = 128.0; // 128×128 sample grid → 16 384 total
const MIN_LOG_LUM: f32 = -10.0; // log(~0.00005) — deepest shadow
const MAX_LOG_LUM: f32 =  4.0;  // log(~55)      — bright highlight
const NUM_BINS:    f32 = 256.0;

// Map a linear luminance value to a histogram bin index [0, 255]
fn lumToBin(lum: f32) -> u32 {
  let logLum = clamp(log(max(lum, 0.0001)), MIN_LOG_LUM, MAX_LOG_LUM);
  let t = (logLum - MIN_LOG_LUM) / (MAX_LOG_LUM - MIN_LOG_LUM);
  return u32(clamp(t * (NUM_BINS - 1.0), 0.0, NUM_BINS - 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_luminance(@builtin(global_invocation_id) gid: vec3<u32>) {
  let uv    = (vec2<f32>(gid.xy) + 0.5) / SAMPLE_DIM;
  let color = textureSampleLevel(hdrTexture, hdrSampler, uv, 0.0).rgb;
  let lum   = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  atomicAdd(&histogram[lumToBin(lum)], 1i);
}
