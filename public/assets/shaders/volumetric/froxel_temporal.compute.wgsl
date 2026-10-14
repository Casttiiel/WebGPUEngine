// Froxel Temporal Reprojection
// Light injection evaluates shadows / lights at a jittered position inside each
// froxel (new jitter every frame). This pass reprojects every froxel centre into
// the previous frame's grid and blends with the accumulated history, turning the
// per-frame jitter into a smooth supersampled result — clean diagonal god rays
// instead of froxel-sized stair-steps.
#include "common/uniforms"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var currentLight: texture_3d<f32>;   // this frame's injected light
@group(2) @binding(1) var historyLight: texture_3d<f32>;   // accumulated light (previous frame)
@group(2) @binding(2) var historySampler: sampler;         // linear, clamp-to-edge
@group(2) @binding(3) var outputLight: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = froxelParams.dimensions.xyz;
  if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y) || gid.z >= u32(dims.z)) {
    return;
  }

  let coord = vec3<i32>(gid);
  let current = textureLoad(currentLight, coord, 0);

  var result = current;
  let historyWeight = froxelParams.jitter.w;

  if (historyWeight > 0.0) {
    let centreVS = froxelCoordToViewSpace(vec3<f32>(gid) + vec3<f32>(0.5), dims,
      froxelParams.depthDistScale, froxelParams.depthDistB, camera.invProjection);
    let centreWS = (camera.invView * vec4<f32>(centreVS, 1.0)).xyz;

    let prevClip = froxelParams.prevViewProj * vec4<f32>(centreWS, 1.0);
    if (prevClip.w > 1e-4) {
      let prevNdc = prevClip.xy / prevClip.w;
      let prevUV = vec2<f32>(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5);
      // Perspective projection: clip.w == view-space depth.
      let prevSlice = froxelDepthToSlice(prevClip.w, froxelParams.depthDistScale, froxelParams.depthDistB);
      let uvw = vec3<f32>(prevUV, prevSlice / dims.z);

      if (all(uvw >= vec3<f32>(0.0)) && all(uvw <= vec3<f32>(1.0))) {
        let history = textureSampleLevel(historyLight, historySampler, uvw, 0.0);
        // Soft edge fade: history next to the grid border is clamped data.
        let edge = min(min(uvw, vec3<f32>(1.0) - uvw).xy * dims.xy, vec2<f32>(1.0));
        let w = historyWeight * min(edge.x, edge.y);
        if (all(history == history)) { // NaN guard
          result = mix(current, history, w);
        }
      }
    }
  }

  textureStore(outputLight, coord, result);
}
