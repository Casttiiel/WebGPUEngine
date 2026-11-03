// ---------------------------------------------------------------------------
// HZB Build — Copy Depth Pass
//
// Copies the main depth prepass texture (depth32float, aspect=depth-only)
// into mip 0 of the Hierarchical Z-Buffer texture (r32float, storage).
//
// Run once per frame AFTER the GBuffer render pass.
//
// Layout:
//   @group(0) @binding(0)  depthTexture  texture_depth_2d       (depth prepass)
//   @group(0) @binding(1)  hzbMip0       texture_storage_2d<r32float,write>  (HZB mip 0)
// ---------------------------------------------------------------------------

@group(0) @binding(0) var depthTexture : texture_depth_2d;
@group(0) @binding(1) var hzbMip0      : texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(hzbMip0);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }

  // textureLoad on texture_depth_2d returns f32 (depth value in [0, 1])
  let depth = textureLoad(depthTexture, vec2<i32>(id.xy), 0);

  // Store into HZB mip 0 — raw depth value (reverse Z: 0=far, 1=near)
  textureStore(hzbMip0, id.xy, vec4<f32>(depth, 0.0, 0.0, 1.0));
}
