// Froxel Coordinate Functions - shared by every froxel pass.
//
// DEPTH DISTRIBUTION
// Slices follow an exponential curve that starts at depth 0 (camera) and ends at
// farPlane (UE-style "linear near, exponential far"):
//
//   depth(s) = (exp2(s / S) - 1) / B          s ∈ [0, N]  (continuous slice coord)
//   s(depth) = S * log2(1 + depth * B)
//
// S = depthDistScale (bigger → more linear), B = (exp2(N / S) - 1) / farPlane.
// A pure log curve (near·(far/near)^t) wastes ~40% of the slices inside the first
// metre and makes the far slices several metres thick — the main source of fog
// leaking through walls. With S = N/2 the slice thickness only grows ~4x from near
// to far.
//
// SLICE / TEXEL CONVENTION
// Slice k spans [depth(k), depth(k+1)].
// Per-froxel data (density, light) is evaluated inside slice k.
// The integrated texture stores at texel k the result from the camera up to the
// FAR boundary depth(k+1), so lookups at depth d use texel coordinate s(d) - 1.

fn froxelSliceToDepth(s: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return (exp2(s / depthDistScale) - 1.0) / depthDistB;
}

fn froxelDepthToSlice(depth: f32, depthDistScale: f32, depthDistB: f32) -> f32 {
  return depthDistScale * log2(1.0 + max(depth, 0.0) * depthDistB);
}

// Compute view space ray direction (z = -1 plane, NOT normalised) from UV coordinates.
// Note: Assumes camera uniforms are available with invProjection matrix
fn computeViewRayFromUV(uv: vec2<f32>, invProjection: mat4x4<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  let rayH = invProjection * ndc;
  let ray = rayH.xyz / rayH.w;
  // Scale so that ray.z == -1: multiplying by a view depth gives the position.
  return ray / max(-ray.z, 1e-8);
}

// View-space position of a continuous froxel coordinate.
// coord.xy in [0, dims.xy] (froxel centre = index + 0.5), coord.z in [0, dims.z].
// froxel y = 0 is the TOP row of the screen.
fn froxelCoordToViewSpace(
  coord: vec3<f32>,
  froxelDimensions: vec3<f32>,
  depthDistScale: f32,
  depthDistB: f32,
  invProjection: mat4x4<f32>
) -> vec3<f32> {
  var uv = coord.xy / froxelDimensions.xy;
  uv.y = 1.0 - uv.y;
  let ray = computeViewRayFromUV(uv, invProjection);
  let depth = froxelSliceToDepth(coord.z, depthDistScale, depthDistB);
  return ray * depth;
}

// Ratio between the distance travelled along the view ray and the view-depth
// delta for the column through `uvTopDown` (1 at the screen centre, > 1 at edges).
fn froxelRayLengthScale(uvTopDown: vec2<f32>, invProjection: mat4x4<f32>) -> f32 {
  let ray = computeViewRayFromUV(vec2<f32>(uvTopDown.x, 1.0 - uvTopDown.y), invProjection);
  return length(ray);
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let gg = g * g;
  let denom = pow(max(1.0 + gg - 2.0 * g * cosTheta, 1e-4), 1.5);
  return (1.0 - gg) / (12.566370614 * denom); // 4π
}
