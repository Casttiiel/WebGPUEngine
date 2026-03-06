// ---------------------------------------------------------------------------
// HZB Occlusion Culling Compute Shader
//
// Run AFTER frustum culling and BEFORE the GBuffer render pass, using the
// HZB pyramid built from the previous frame's depth buffer.
//
// Per-object test:
//   1. If frustum pass already zeroed instanceCount → skip.
//   2. Project the world-space AABB 8 corners through viewProj.
//   3. Compute NDC screen extents and the front-face depth (minimum NDC z).
//   4. Choose a conservative HZB mip level that covers the projected footprint.
//   5. Sample HZB at the projected centre → maxDepth in that region.
//   6. If objectFrontDepth > maxDepth → fully behind an occluder → cull.
//
// Layout:
//   @group(0) @binding(0)  camera       uniform   (CameraHZBData)
//   @group(0) @binding(1)  objects      storage-r (ObjectData[] — same as frustum pass)
//   @group(0) @binding(2)  indirectArgs storage-rw(DrawArgs[]  — same as frustum pass)
//   @group(0) @binding(3)  hzbTexture   texture_2d<f32>
//   @group(0) @binding(4)  culledCount  storage-rw(atomic<u32>)  — debug counter
// ---------------------------------------------------------------------------

// ---- Structs ---------------------------------------------------------------

struct CameraHZBData {
  viewProj     : mat4x4<f32>,
  // HZB texture parameters
  hzbWidth     : f32,   // full-resolution HZB width
  hzbHeight    : f32,   // full-resolution HZB height
  hzbMipCount  : f32,   // total mip levels in the HZB pyramid
  _pad         : f32,
}

struct AABB {
  min    : vec3<f32>,
  _pad1  : f32,
  max    : vec3<f32>,
  _pad2  : f32,
}

struct ObjectData {
  bounds        : AABB,
  modelMatrix   : mat4x4<f32>,
  indexCount    : u32,
  instanceCount : u32,
  firstIndex    : u32,
  baseVertex    : i32,
  firstInstance : u32,
  _pad          : array<u32, 3>,
}

struct DrawArgs {
  indexCount    : u32,
  instanceCount : u32,
  firstIndex    : u32,
  baseVertex    : i32,
  firstInstance : u32,
}

// ---- Bindings --------------------------------------------------------------

@group(0) @binding(0) var<uniform>             camera      : CameraHZBData;
@group(0) @binding(1) var<storage, read>       objects     : array<ObjectData>;
@group(0) @binding(2) var<storage, read_write> indirectArgs: array<DrawArgs>;
@group(0) @binding(3) var                      hzbTexture  : texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> culledCount : atomic<u32>;

// ---- Main ------------------------------------------------------------------

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let idx = id.x;
  if (idx >= arrayLength(&objects)) {
    return;
  }

  // If the frustum pass already culled this object, nothing to do.
  if (indirectArgs[idx].instanceCount == 0u) {
    return;
  }

  let obj = objects[idx];

  // --- Project all 8 AABB corners through viewProj -------------------------
  // Track NDC extents and the minimum (front-face) NDC Z.
  var ndcMinXY = vec2<f32>( 1e20,  1e20);
  var ndcMaxXY = vec2<f32>(-1e20, -1e20);
  var ndcMinZ  = f32(1e20);   // smallest Z = closest corner to camera

  var anyVisible = false;
  var anyClipped = false;   // true if at least one corner is behind the near plane

  for (var i = 0u; i < 8u; i++) {
    let lx = select(obj.bounds.min.x, obj.bounds.max.x, (i & 1u) != 0u);
    let ly = select(obj.bounds.min.y, obj.bounds.max.y, (i & 2u) != 0u);
    let lz = select(obj.bounds.min.z, obj.bounds.max.z, (i & 4u) != 0u);

    let worldPos = obj.modelMatrix * vec4<f32>(lx, ly, lz, 1.0);
    let clipPos  = camera.viewProj * worldPos;

    // Corner is behind the near plane (camera inside / straddling the AABB)
    if (clipPos.w <= 0.0 || clipPos.z < 0.0) {
      anyClipped = true;
      continue;
    }

    let rcpW   = 1.0 / clipPos.w;
    let ndcXY  = clipPos.xy * rcpW;
    let ndcZ   = clipPos.z  * rcpW;

    ndcMinXY = min(ndcMinXY, ndcXY);
    ndcMaxXY = max(ndcMaxXY, ndcXY);
    ndcMinZ  = min(ndcMinZ,  ndcZ );
    anyVisible = true;
  }

  // If ANY corner is clipped the object straddles the near plane (camera is inside
  // or very close). The HZB cannot represent this case — keep the object visible.
  if (anyClipped) {
    return;
  }

  // All corners behind near plane — frustum should have caught this, but skip.
  if (!anyVisible) {
    return;
  }

  // Clamp NDC extents to the visible frustum volume [-1, 1]
  ndcMinXY = clamp(ndcMinXY, vec2<f32>(-1.0), vec2<f32>(1.0));
  ndcMaxXY = clamp(ndcMaxXY, vec2<f32>(-1.0), vec2<f32>(1.0));
  ndcMinZ  = clamp(ndcMinZ,  0.0, 1.0);

  // --- Convert NDC → UV ([0,1] texture coordinates) -----------------------
  // WebGPU NDC: X = -1..+1 (left→right), Y = -1..+1 (bottom→top)
  // Texture UV:  U = 0..1  (left→right),  V = 0..1  (top→bottom)  ← Y flipped
  let uvMinX = ndcMinXY.x * 0.5 + 0.5;
  let uvMaxX = ndcMaxXY.x * 0.5 + 0.5;
  let uvMinY = 1.0 - (ndcMaxXY.y * 0.5 + 0.5);  // flip Y
  let uvMaxY = 1.0 - (ndcMinXY.y * 0.5 + 0.5);

  // --- Select HZB mip level (floor strategy, 4-corner sampling) ------------
  // Use floor(log2) so the projected footprint spans AT MOST 2×2 texels at
  // the chosen mip.  We then sample all 4 corners of the footprint and take
  // the maximum — this guarantees a conservative (highest) depth value over
  // the entire projected area without ever under-estimating the occluder depth.
  //
  // Why NOT ceil(log2) + centre sample:
  //   - ceil forces a coarser mip where the footprint fits in 1 texel, but
  //     the footprint may straddle two texels → the centre sample misses half.
  //   - At large distances (projPixels < 1) ceil = 0 and the centre texel
  //     may not coincide with the wall at all.
  let projPixelW = (uvMaxX - uvMinX) * camera.hzbWidth;
  let projPixelH = (uvMaxY - uvMinY) * camera.hzbHeight;
  let projPixelMax = max(max(projPixelW, projPixelH), 1.0);
  let mip = i32(clamp(floor(log2(projPixelMax)), 0.0, camera.hzbMipCount - 1.0));

  // --- Sample the 4 corners of the projected footprint at this mip ---------
  let mipDims = vec2<f32>(textureDimensions(hzbTexture, mip));
  let tx0 = clamp(i32(uvMinX * mipDims.x), 0, i32(mipDims.x) - 1);
  let ty0 = clamp(i32(uvMinY * mipDims.y), 0, i32(mipDims.y) - 1);
  let tx1 = clamp(i32(uvMaxX * mipDims.x), 0, i32(mipDims.x) - 1);
  let ty1 = clamp(i32(uvMaxY * mipDims.y), 0, i32(mipDims.y) - 1);

  let d00 = textureLoad(hzbTexture, vec2<i32>(tx0, ty0), mip).r;
  let d10 = textureLoad(hzbTexture, vec2<i32>(tx1, ty0), mip).r;
  let d01 = textureLoad(hzbTexture, vec2<i32>(tx0, ty1), mip).r;
  let d11 = textureLoad(hzbTexture, vec2<i32>(tx1, ty1), mip).r;
  let hzbMaxDepth = max(max(d00, d10), max(d01, d11));

  // --- Occlusion test -------------------------------------------------------
  // Depth convention: 0 = near, 1 = far (standard non-reversed-Z).
  // ndcMinZ is the closest (smallest Z) corner of the AABB.
  // If even the closest corner is farther than the max occluder depth in the
  // HZB region, the whole AABB is behind occluders → cull it.
  //
  // Bias: at large distances both wall and object NDC-Z values are compressed
  // close to 1.0, so the absolute difference shrinks.  A fixed 0.002 bias
  // swamps that difference and prevents culling.  Use a depth-proportional
  // bias instead: it's negligible at close range (handled by anyClipped) and
  // stays below the actual NDC precision loss at far range.
  let DEPTH_BIAS = ndcMinZ * 0.001;
  if (ndcMinZ > hzbMaxDepth + DEPTH_BIAS) {
    indirectArgs[idx].instanceCount = 0u;
    atomicAdd(&culledCount, 1u);
  }
}
