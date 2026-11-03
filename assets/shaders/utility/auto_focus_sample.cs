// ---------------------------------------------------------------------------
// Auto-Focus Center Sample Compute Shader
//
// Reads the linear depth [0,1] of the center screen pixel from the G-Buffer
// linearDepth texture and writes it into a single-float storage buffer.
// The CPU reads this buffer back asynchronously (1-frame lag) and uses the
// result to drive the smooth focus-distance lerp in DepthOfFieldComponent.
//
// Usage: dispatch (1,1,1) — one thread is enough for a single pixel read.
//
// Bindings:
//   @binding(0)  gLinearDepth  texture_2d<f32>  (R = linear depth [0,1])
//   @binding(1)  result        storage-rw f32    (output linear depth)
// ---------------------------------------------------------------------------

@group(0) @binding(0) var                      gLinearDepth : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result       : f32;

@compute @workgroup_size(1)
fn main() {
  let dims = textureDimensions(gLinearDepth);
  // Integer centre pixel — avoids any rounding issues at odd resolutions.
  let cx = dims.x / 2u;
  let cy = dims.y / 2u;
  result = textureLoad(gLinearDepth, vec2<u32>(cx, cy), 0).r;
}
