// ---------------------------------------------------------------------------
// HZB Build — Mip Downsample Pass
//
// Reduces a source mip of the HZB pyramid (r32float) into the next mip by
// taking the MAX of the 2×2 texel block.  Storing the max means a single
// HZB sample at mip M conservatively represents the farthest (largest)
// depth across the entire 2^M × 2^M region at full resolution.
//
// One dispatch per mip transition: mip N → mip N+1.
//
// Layout:
//   @group(0) @binding(0)  params    uniform  (srcMipWidth, srcMipHeight, _, _)
//   @group(0) @binding(1)  srcMip    texture_2d<f32>                  (HZB mip N, single-mip view)
//   @group(0) @binding(2)  dstMip    texture_storage_2d<r32float,write> (HZB mip N+1)
// ---------------------------------------------------------------------------

struct DownsampleParams {
  srcMipWidth  : u32,
  srcMipHeight : u32,
  _pad0        : u32,
  _pad1        : u32,
}

@group(0) @binding(0) var<uniform> params : DownsampleParams;
@group(0) @binding(1) var srcMip          : texture_2d<f32>;
@group(0) @binding(2) var dstMip          : texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dstDims = textureDimensions(dstMip);
  if (id.x >= dstDims.x || id.y >= dstDims.y) {
    return;
  }

  // The four source texels corresponding to this destination texel
  let x0 = id.x * 2u;
  let y0 = id.y * 2u;
  let x1 = min(x0 + 1u, params.srcMipWidth  - 1u);
  let y1 = min(y0 + 1u, params.srcMipHeight - 1u);

  let d00 = textureLoad(srcMip, vec2<u32>(x0, y0), 0).r;
  let d10 = textureLoad(srcMip, vec2<u32>(x1, y0), 0).r;
  let d01 = textureLoad(srcMip, vec2<u32>(x0, y1), 0).r;
  let d11 = textureLoad(srcMip, vec2<u32>(x1, y1), 0).r;

  // Conservative: take the maximum depth so no occluder is missed
  let maxDepth = max(max(d00, d10), max(d01, d11));
  textureStore(dstMip, id.xy, vec4<f32>(maxDepth, 0.0, 0.0, 1.0));
}
