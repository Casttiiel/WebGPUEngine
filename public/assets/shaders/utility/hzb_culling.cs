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
// Debug output: hzbDebug[0] = atomic cull count (max 32 entries).
// Entry i (i < 32) occupies hzbDebug[1 + i*12 .. 1 + i*12 + 11]:
//   [0] objectIdx  [1] ndcMinZ_bits  [2] hzbMaxDepth_bits  [3] mip
//   [4] tx0  [5] ty0  [6] tx1  [7] ty1
//   [8] uvMinX_bits  [9] uvMaxX_bits  [10] uvMinY_bits  [11] uvMaxY_bits
@group(0) @binding(5) var<storage, read_write> hzbDebug    : array<atomic<u32>>;

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

  for (var i = 0u; i < 8u; i++) {
    let lx = select(obj.bounds.min.x, obj.bounds.max.x, (i & 1u) != 0u);
    let ly = select(obj.bounds.min.y, obj.bounds.max.y, (i & 2u) != 0u);
    let lz = select(obj.bounds.min.z, obj.bounds.max.z, (i & 4u) != 0u);

    let worldPos = obj.modelMatrix * vec4<f32>(lx, ly, lz, 1.0);
    let clipPos  = camera.viewProj * worldPos;

    // Any corner behind the near plane means the object straddles it (camera inside
    // or very close). The HZB cannot represent this case — keep visible immediately.
    // Returning here (instead of continue + anyClipped flag) prevents accumulating
    // ndcMinZ only from far corners, which would produce a falsely large ndcMinZ
    // and incorrectly cull objects that are partially visible from up close.
    if (clipPos.w <= 0.0 || clipPos.z < 0.0) {
      return;
    }

    let rcpW   = 1.0 / clipPos.w;
    let ndcXY  = clipPos.xy * rcpW;
    let ndcZ   = clipPos.z  * rcpW;

    ndcMinXY = min(ndcMinXY, ndcXY);
    ndcMaxXY = max(ndcMaxXY, ndcXY);
    ndcMinZ  = min(ndcMinZ,  ndcZ );
    anyVisible = true;
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

  let projPixelW = (uvMaxX - uvMinX) * camera.hzbWidth;
  let projPixelH = (uvMaxY - uvMinY) * camera.hzbHeight;
  let projPixelMax = max(max(projPixelW, projPixelH), 1.0);

  // Skip tiny footprints: HZB depth at the required mip is dominated by
  // surrounding geometry, not the actual occluder.  Cull savings for sub-4px
  // objects don't justify the false-cull risk.
  if (projPixelMax < 4.0) {
    return;
  }

  // Skip large objects: anything that occupies more than half the screen in
  // either dimension is almost never fully occluded and its depth contaminates
  // adjacent HZB texels via MAX downsample, causing false culls on background
  // objects that project to the same mip region.
  if (projPixelW > camera.hzbWidth * 0.5 || projPixelH > camera.hzbHeight * 0.5) {
    return;
  }

  // --- Select HZB mip level -------------------------------------------------
  // Add a proportional margin before log2 so footprints near a power-of-2
  // boundary round up to the next mip, reducing contamination from the
  // MAX-downsample depth of large near-objects at the same mip boundary.
  let footprintMargin    = max(projPixelMax * 0.05, 2.0);
  let projPixelMaxBiased = projPixelMax + footprintMargin;
  let mip = i32(clamp(ceil(log2(projPixelMaxBiased)), 0.0, camera.hzbMipCount - 1.0));

  // --- Sample the projected footprint at mip-1 (one level finer) -----------
  // mip was selected so the footprint fits in ≤1 texel at that level.
  // Sampling at mip-1 halves each texel's screen coverage, so the depth
  // values are less likely to be contaminated by the MAX-downsample of a
  // large near-object from a neighbouring region.  The cost is up to 3×3
  // samples at the finer level instead of 1–2 at the coarser one, which is
  // acceptable given the reduced false-cull rate.
  let mipFine  = max(mip - 1, 0);
  let mipDims  = vec2<f32>(textureDimensions(hzbTexture, mipFine));
  let mipDimsI = vec2<i32>(textureDimensions(hzbTexture, mipFine));
  let tx0 = clamp(i32(uvMinX * mipDims.x) - 1, 0, mipDimsI.x - 1);
  let ty0 = clamp(i32(uvMinY * mipDims.y) - 1, 0, mipDimsI.y - 1);
  let tx1 = clamp(i32(uvMaxX * mipDims.x) + 1, 0, mipDimsI.x - 1);
  let ty1 = clamp(i32(uvMaxY * mipDims.y) + 1, 0, mipDimsI.y - 1);

  var hzbMaxDepth = 0.0;
  for (var ty = ty0; ty <= ty1; ty++) {
    for (var tx = tx0; tx <= tx1; tx++) {
      let d = textureLoad(hzbTexture, vec2<i32>(tx, ty), mipFine).r;
      hzbMaxDepth = max(hzbMaxDepth, d);
    }
  }

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
  // Proportional bias keeps false culls rare at all distances; the absolute
  // minimum of 0.0001 prevents the bias from disappearing at very small ndcMinZ
  // values where non-reversed Z precision is already low.
  let DEPTH_BIAS = max(ndcMinZ * 0.001, 0.0001);
  if (ndcMinZ > hzbMaxDepth + DEPTH_BIAS) {
    indirectArgs[idx].instanceCount = 0u;
    atomicAdd(&culledCount, 1u);

    // Record debug data for CPU readback (capped at 32 entries).
    let debugSlot = atomicAdd(&hzbDebug[0], 1u);
    if (debugSlot < 32u) {
      let base = 1u + debugSlot * 12u;
      atomicStore(&hzbDebug[base +  0u], idx);
      atomicStore(&hzbDebug[base +  1u], bitcast<u32>(ndcMinZ));
      atomicStore(&hzbDebug[base +  2u], bitcast<u32>(hzbMaxDepth));
      atomicStore(&hzbDebug[base +  3u], u32(mipFine));
      atomicStore(&hzbDebug[base +  4u], u32(tx0));
      atomicStore(&hzbDebug[base +  5u], u32(ty0));
      atomicStore(&hzbDebug[base +  6u], u32(tx1));
      atomicStore(&hzbDebug[base +  7u], u32(ty1));
      atomicStore(&hzbDebug[base +  8u], bitcast<u32>(uvMinX));
      atomicStore(&hzbDebug[base +  9u], bitcast<u32>(uvMaxX));
      atomicStore(&hzbDebug[base + 10u], bitcast<u32>(uvMinY));
      atomicStore(&hzbDebug[base + 11u], bitcast<u32>(uvMaxY));
    }
  }
}
