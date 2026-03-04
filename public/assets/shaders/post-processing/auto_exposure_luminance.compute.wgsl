// Auto Exposure - Luminance Reduction Pass
// Samples 128×128 = 16 384 points from the HDR scene texture using
// parallel workgroup reduction, accumulates scaled log-luminance into
// an atomic i32 buffer for the adaptation pass to consume next dispatch.

@group(0) @binding(0) var hdrTexture: texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;

// accumulator[0] = sum of log-luminances scaled by SCALE (atomic i32)
@group(1) @binding(0) var<storage, read_write> accumulator: array<atomic<i32>>;

const SCALE:       f32 = 1000.0;
const SAMPLE_DIM:  f32 = 128.0; // 128×128 sample grid over the UV [0,1]²

var<workgroup> sharedLum: array<f32, 64>; // 8×8 workgroup = 64 threads

@compute @workgroup_size(8, 8, 1)
fn cs_luminance(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
) {
  // UV position for this thread (covers the full [0,1]² uniformly)
  let uv = (vec2<f32>(gid.xy) + 0.5) / SAMPLE_DIM;

  let color  = textureSampleLevel(hdrTexture, hdrSampler, uv, 0.0).rgb;
  let lum    = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  sharedLum[lid] = log(max(lum, 0.001));

  workgroupBarrier();

  // Parallel reduction: 64 → 32 → 16 → 8 → 4 → 2 → 1
  if (lid < 32u) { sharedLum[lid] += sharedLum[lid + 32u]; } workgroupBarrier();
  if (lid < 16u) { sharedLum[lid] += sharedLum[lid + 16u]; } workgroupBarrier();
  if (lid < 8u)  { sharedLum[lid] += sharedLum[lid + 8u];  } workgroupBarrier();
  if (lid < 4u)  { sharedLum[lid] += sharedLum[lid + 4u];  } workgroupBarrier();
  if (lid < 2u)  { sharedLum[lid] += sharedLum[lid + 2u];  } workgroupBarrier();
  if (lid < 1u)  { sharedLum[lid] += sharedLum[lid + 1u];  } workgroupBarrier();

  // Thread 0 writes the workgroup sum to the global atomic accumulator
  if (lid == 0u) {
    let scaledSum = i32(sharedLum[0] * SCALE);
    atomicAdd(&accumulator[0], scaledSum);
  }
}
