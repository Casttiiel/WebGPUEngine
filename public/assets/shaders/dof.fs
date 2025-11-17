#include "common/uniforms"

struct DOFUniforms {
    focus_z_center_in_focus: f32,
    focus_z_margin_in_focus: f32,
    focus_transition_distance: f32,
    focus_modifier: f32,
}


@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures - using the standard G-Buffer layout
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;     // Input texture (lit scene)
@group(1) @binding(1) var gNormals: texture_2d<f32>;     // World normals
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>; // Linear depth
@group(1) @binding(3) var samplerGBuffer: sampler;      // Shared sampler

// DOF Parameters
@group(2) @binding(0) var focusTexture: texture_2d<f32>;
@group(2) @binding(1) var blurTexture: texture_2d<f32>;
@group(2) @binding(2) var<uniform> dofParams: DOFUniforms;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var in_focus  = textureSample(focusTexture, samplerGBuffer, uv);
  var out_focus  = textureSample(blurTexture, samplerGBuffer, uv);
  var zlinear = textureSample(gLinearDepth, samplerGBuffer, uv).x * camera.cameraZFar;

  // if focus_z_center_in_focus   = 300;
  // if focus_z_margin_in_focus   =  50;
  // if focus_transition_distance = 100;

  // We want for z between 250 and 350 => all_in_focus     ++++++++++
  // We want for z between 350 and 450 => mix between in_focus and out_Focus   XXXXX
  // We want for z between 150 and 250 => mix between in_focus and out_Focus   XXXXX
  // We want for z beyond  450 or <150 => all out_Focus    ----------
  //                        300
  // ---------XXXXXXXXXX+++++F+++++XXXXXXXXXX-------------
  var distance_to_focus = abs( zlinear - dofParams.focus_z_center_in_focus );
  var amount_of_out_blur = smoothstep( dofParams.focus_z_margin_in_focus, dofParams.focus_z_margin_in_focus + dofParams.focus_transition_distance, distance_to_focus );
  amount_of_out_blur = pow( amount_of_out_blur, dofParams.focus_modifier);
  
  //return amount_of_out_blur;
  return amount_of_out_blur * out_focus + ( 1. - amount_of_out_blur) * in_focus;
}