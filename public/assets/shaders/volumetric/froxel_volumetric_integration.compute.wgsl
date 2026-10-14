#include "common/uniforms"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Media: sigmaS,sigmaT
@group(1) @binding(0) var froxelMediaTexture: texture_3d<f32>;
@group(1) @binding(1) var froxelLightTexture: texture_3d<f32>;
@group(1) @binding(2) var froxelIntegratedTexture: texture_storage_3d<rgba16float, write>;

@group(2) @binding(0) var<uniform> camera: CameraUniforms;

// Front-to-back integration, one thread per froxel column.
//
// Texel z of the output holds (in-scattered radiance, transmittance) from the
// camera up to the FAR boundary of slice z. The raymarch pass looks up texel
// s(depth) - 1 with trilinear filtering, which linearly interpolates inside the
// slice that contains the surface — no fog from behind the surface is added.
//
// Geometry is deliberately NOT used here: the lookup depth already stops the
// integral at the surface for every pixel. Truncating whole columns at a single
// per-froxel depth sample created dark halos around silhouettes.
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = froxelParams.dimensions;

  if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y)) {
    return;
  }

  let slices = u32(dims.z);

  // View depth → distance travelled along this column's ray.
  let columnUV = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / dims.xy;
  let rayScale = froxelRayLengthScale(columnUV, camera.invProjection);

  var T: f32 = 1.0;                  // accumulated transmittance
  var S: vec3<f32> = vec3<f32>(0.0); // accumulated in-scattering (RGB)
  var depth0 = 0.0;                  // near boundary of the current slice

  for (var z: u32 = 0u; z < slices; z = z + 1u) {
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(z));

    let depth1 = froxelSliceToDepth(f32(z + 1u), froxelParams.depthDistScale, froxelParams.depthDistB);
    let ds = (depth1 - depth0) * rayScale;
    depth0 = depth1;

    if (T > 1e-4) {
      let sigma = textureLoad(froxelMediaTexture, coord, 0);
      let sigmaS = max(sigma.r, 0.0);
      let sigmaT = max(sigma.g, 0.0);
      let L = textureLoad(froxelLightTexture, coord, 0).rgb;

      // Multiple scattering approximation: full boost in thin media, fades out
      // once the column becomes opaque.
      let msBoost = mix(volumetricSettings.multipleScatteringBoost, 1.0, 1.0 - T);
      let scatter = L * sigmaS * msBoost;

      // Energy-conserving analytic integration over the slice (Hillaire 2015):
      // ∫0^ds scatter·e^(-σt·x) dx = scatter·(1 - e^(-σt·ds)) / σt
      let sliceT = exp(-sigmaT * ds);
      let integ = select(scatter * ds, scatter * (1.0 - sliceT) / max(sigmaT, 1e-7), sigmaT > 1e-5);
      S += T * integ;
      T *= sliceT;
    }

    textureStore(froxelIntegratedTexture, coord, vec4<f32>(S, T));
  }
}
