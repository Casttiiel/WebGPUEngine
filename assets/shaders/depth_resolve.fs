@group(0) @binding(0) var msaa_depth_texture: texture_depth_multisampled_2d;

@fragment
fn fs(@builtin(position) coord: vec4<f32>) -> @builtin(frag_depth) f32 {
  let pixel_coord = vec2<i32>(coord.xy);
  
  // Sample all MSAA samples and find the closest (minimum depth)
  let sample_count = 4u; // 4x MSAA
  var min_depth = 1.0;
  
  for (var sample_index = 0u; sample_index < sample_count; sample_index++) {
    let depth_sample = textureLoad(msaa_depth_texture, pixel_coord, sample_index);
    min_depth = min(min_depth, depth_sample);
  }
  
  return min_depth;
}
