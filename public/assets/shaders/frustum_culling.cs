struct FrustumPlanes {
  left: vec4<f32>,
  right: vec4<f32>,
  top: vec4<f32>,
  bottom: vec4<f32>,
  near: vec4<f32>,
  far: vec4<f32>,
}

struct AABB {
  min: vec3<f32>,
  _padding1: f32,
  max: vec3<f32>,
  _padding2: f32,
}

struct ObjectData {
  bounds: AABB,
  modelMatrix: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> frustum: FrustumPlanes;
@group(0) @binding(1) var<storage, read> objects: array<ObjectData>;
@group(0) @binding(2) var<storage, read_write> visibility: array<u32>;
@group(0) @binding(3) var<storage, read_write> visibleCount: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let objectIndex = id.x;
  if (objectIndex >= arrayLength(&objects)) {
    return;
  }

  let object = objects[objectIndex];
  
  // Transform AABB to world space
  let worldAABB = transformAABB(object.bounds, object.modelMatrix);
  
  // Test against frustum
  if (isAABBInFrustum(worldAABB, frustum)) {
    visibility[objectIndex] = 1u;
    atomicAdd(&visibleCount, 1u);
  } else {
    visibility[objectIndex] = 0u;
  }
}

fn transformAABB(aabb: AABB, modelMatrix: mat4x4<f32>) -> AABB {
  // Transform all 8 corners and find new min/max
  var minCorner = vec3<f32>(1e30);
  var maxCorner = vec3<f32>(-1e30);
  
  for (var i = 0u; i < 8u; i++) {
    let corner = vec3<f32>(
      select(aabb.min.x, aabb.max.x, (i & 1u) != 0u),
      select(aabb.min.y, aabb.max.y, (i & 2u) != 0u),
      select(aabb.min.z, aabb.max.z, (i & 4u) != 0u)
    );
    
    let worldCorner = (modelMatrix * vec4<f32>(corner, 1.0)).xyz;
    minCorner = min(minCorner, worldCorner);
    maxCorner = max(maxCorner, worldCorner);
  }
  
  // Construct AABB properly with struct fields
  var result: AABB;
  result.min = minCorner;
  result.max = maxCorner;
  result._padding1 = 0.0;
  result._padding2 = 0.0;
  return result;
}

fn isAABBInFrustum(aabb: AABB, frustum: FrustumPlanes) -> bool {
  // Use exact MCV_Supermarket isVisible algorithm
  // Reference: MCV_Supermarket-master/bin/data/shaders/gpu_culling.fx
  let planes = array<vec4<f32>, 6>(
    frustum.left, frustum.right, frustum.top,
    frustum.bottom, frustum.near, frustum.far
  );
  
  // Calculate AABB center and half extents (like MCV_Supermarket TInstance struct)
  let aabbCenter = (aabb.min + aabb.max) * 0.5;
  let aabbHalf = (aabb.max - aabb.min) * 0.5;
  
  for (var i = 0; i < 6; i++) {
    let plane = planes[i];
    
    // MCV_Supermarket isVisible algorithm:
    // const float r = dot( abs( plane.xyz ), instance.aabb_half );
    // const float c = dot( plane.xyz, instance.aabb_center ) + plane.w;
    // if( c < -r ) return false;
    
    let r = dot(abs(plane.xyz), aabbHalf);
    let c = dot(plane.xyz, aabbCenter) + plane.w;
    
    if (c < -r) {
      return false;
    }
  }
  
  return true;
}
