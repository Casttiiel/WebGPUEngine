// ---------------------------------------------------------------------------
// GPU Frustum Culling — Indirect Draw Writer
//
// Reads per-object AABB + modelMatrix, tests against the camera frustum,
// and writes DrawIndexedIndirectParameters directly into the indirectArgs
// buffer.  instanceCount is set to 0 for culled objects so the GPU silently
// skips that draw call with zero overhead on the CPU side.
//
// Layout:
//   @group(0) @binding(0)  frustum  uniform   (FrustumPlanes, 96 bytes)
//   @group(0) @binding(1)  objects  storage-r (ObjectData[], 128 bytes each)
//   @group(0) @binding(2)  indirectArgs storage-rw (DrawArgs[], 20 bytes each)
// ---------------------------------------------------------------------------

struct FrustumPlanes {
  left:   vec4<f32>,
  right:  vec4<f32>,
  top:    vec4<f32>,
  bottom: vec4<f32>,
  near:   vec4<f32>,
  far:    vec4<f32>,
}

struct AABB {
  min:      vec3<f32>,
  _pad1:    f32,
  max:      vec3<f32>,
  _pad2:    f32,
}

// Per-object data (128 bytes, uploaded from CPU each frame)
//   [  0.. 31]  bounds AABB               (32 bytes)
//   [ 32.. 95]  modelMatrix mat4x4<f32>   (64 bytes)
//   [ 96..115]  draw args (5 × u32/i32)   (20 bytes)
//   [116..127]  _pad[3]                   (12 bytes)
struct ObjectData {
  bounds:        AABB,
  modelMatrix:   mat4x4<f32>,
  indexCount:    u32,
  instanceCount: u32,
  firstIndex:    u32,
  baseVertex:    i32,
  firstInstance: u32,
  _pad:          array<u32, 3>,
}

// Matches WebGPU drawIndexedIndirect buffer layout (20 bytes)
struct DrawArgs {
  indexCount:    u32,
  instanceCount: u32,
  firstIndex:    u32,
  baseVertex:    i32,
  firstInstance: u32,
}

@group(0) @binding(0) var<uniform>            frustum:     FrustumPlanes;
@group(0) @binding(1) var<storage, read>      objects:     array<ObjectData>;
@group(0) @binding(2) var<storage, read_write> indirectArgs: array<DrawArgs>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let objectIndex = id.x;
  if (objectIndex >= arrayLength(&objects)) {
    return;
  }

  let object = objects[objectIndex];

  // Transform local-space AABB to world space using modelMatrix
  let worldAABB = transformAABB(object.bounds, object.modelMatrix);

  // Frustum test — write instanceCount = 0 if culled
  let visible = isAABBInFrustum(worldAABB, frustum);

  var args: DrawArgs;
  args.indexCount    = object.indexCount;
  args.instanceCount = select(0u, object.instanceCount, visible);
  args.firstIndex    = object.firstIndex;
  args.baseVertex    = object.baseVertex;
  args.firstInstance = object.firstInstance;

  indirectArgs[objectIndex] = args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn transformAABB(aabb: AABB, m: mat4x4<f32>) -> AABB {
  var minC = vec3<f32>( 1e30,  1e30,  1e30);
  var maxC = vec3<f32>(-1e30, -1e30, -1e30);

  for (var i = 0u; i < 8u; i++) {
    let corner = vec3<f32>(
      select(aabb.min.x, aabb.max.x, (i & 1u) != 0u),
      select(aabb.min.y, aabb.max.y, (i & 2u) != 0u),
      select(aabb.min.z, aabb.max.z, (i & 4u) != 0u),
    );
    let wc = (m * vec4<f32>(corner, 1.0)).xyz;
    minC = min(minC, wc);
    maxC = max(maxC, wc);
  }

  var result: AABB;
  result.min  = minC;
  result.max  = maxC;
  result._pad1 = 0.0;
  result._pad2 = 0.0;
  return result;
}

fn isAABBInFrustum(aabb: AABB, f: FrustumPlanes) -> bool {
  let planes = array<vec4<f32>, 6>(
    f.left, f.right, f.top, f.bottom, f.near, f.far,
  );

  let center = (aabb.min + aabb.max) * 0.5;
  let half   = (aabb.max - aabb.min) * 0.5;

  for (var i = 0; i < 6; i++) {
    let p = planes[i];
    let r = dot(abs(p.xyz), half);
    let c = dot(p.xyz, center) + p.w;
    if (c < -r) {
      return false;
    }
  }
  return true;
}
