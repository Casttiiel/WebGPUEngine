#include "common/volumetric/structs"
#include "common/volumetric/froxel"

@group(0) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(0) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

// Media: sigmaS,sigmaT
@group(1) @binding(0) var froxelMediaTexture: texture_3d<f32>;
@group(1) @binding(1) var froxelLightTexture: texture_3d<f32>;
@group(1) @binding(2) var froxelIntegratedTexture: texture_storage_3d<rgba16float, write>;

// G-Buffer linear depth (R = viewZ / cameraFar, 0 = sky/no geometry)
@group(2) @binding(0) var linearDepth: texture_2d<f32>;

const MAX_SLICES: u32 = 1024u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = froxelParams.dimensions;

  // 1 hilo por columna (x,y)
  if (gid.x >= u32(dims.x) || gid.y >= u32(dims.y)) {
    return;
  }

  let slices = u32(dims.z);

  // ── Depth-aware integration ───────────────────────────────────────────────
  // Sample the G-Buffer linear depth once per column.  depth01 == 0 means sky
  // (G-Buffer cleared to 0, no geometry rendered at that pixel), so we treat
  // it as "no occluder → fog runs to the froxel far plane."
  let froxelScreenUV = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / dims.xy;
  let depthDims  = vec2<f32>(textureDimensions(linearDepth));
  let depthPixel = clamp(vec2<i32>(froxelScreenUV * depthDims),
                         vec2<i32>(0, 0),
                         vec2<i32>(depthDims) - vec2<i32>(1, 1));
  let rawDepth01    = textureLoad(linearDepth, depthPixel, 0).r;
  let cameraFar     = volumetricSettings.windDir.y;  // packed by FroxelVolumetricScattering.ts
  // rawDepth01 = 0 ↔ sky (clear value) → treat as full far-plane depth
  let sceneViewDist = select(froxelParams.farPlane, rawDepth01 * cameraFar, rawDepth01 > 1e-5);
  // ─────────────────────────────────────────────────────────────────────────

  // Integración acumulada por columna
  var T: f32 = 1.0;                 // transmittance acumulada
  var S: vec3<f32> = vec3<f32>(0.0); // scattering acumulado (RGB)

  for (var z: u32 = 0u; z < MAX_SLICES; z = z + 1u) {
    if (z >= slices) { break; }

    // ── Geometry depth stop ───────────────────────────────────────────────
    // Compute the front face of this froxel slice in view space.
    // If it starts behind the scene geometry, fog cannot exist here.
    // Fill remaining slices with the current accumulated value and exit.
    let slicesF      = dims.z;  // f32
    let sliceFrontVZ = froxelParams.nearPlane *
                       pow(froxelParams.farPlane / froxelParams.nearPlane, f32(z) / slicesF);
    if (sliceFrontVZ >= sceneViewDist) {
      for (var zz = z; zz < slices; zz++) {
        textureStore(froxelIntegratedTexture,
                     vec3<i32>(i32(gid.x), i32(gid.y), i32(zz)),
                     vec4<f32>(S, T));
      }
      break;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (T < 0.001) {
        // Rellenar slices restantes con el valor actual
        for (var zz = z; zz < slices; zz++) {
            let c = vec3<i32>(i32(gid.x), i32(gid.y), i32(zz));
            textureStore(froxelIntegratedTexture, c, vec4<f32>(S, 0.0));
        }
        break;
    }
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(z));

    // 5-tap XY box filter on density and light before integration.
    // rg32float is not hardware-filterable, so we average 4 neighbours manually.
    // This prevents abrupt XY density jumps from creating sharp integration
    // discontinuities that trilinear on the final read can't recover.
    let dimI = vec3<i32>(i32(dims.x), i32(dims.y), i32(dims.z));
    let cXP  = vec3<i32>(min(coord.x + 1, dimI.x - 1), coord.y, coord.z);
    let cXM  = vec3<i32>(max(coord.x - 1, 0),           coord.y, coord.z);
    let cYP  = vec3<i32>(coord.x, min(coord.y + 1, dimI.y - 1), coord.z);
    let cYM  = vec3<i32>(coord.x, max(coord.y - 1, 0),           coord.z);

    let sigma = (textureLoad(froxelMediaTexture, coord, 0) +
                 textureLoad(froxelMediaTexture, cXP,   0) +
                 textureLoad(froxelMediaTexture, cXM,   0) +
                 textureLoad(froxelMediaTexture, cYP,   0) +
                 textureLoad(froxelMediaTexture, cYM,   0)) * 0.2;
    let sigmaS = max(sigma.r, 0.0);
    let sigmaT = max(sigma.g, 0.0);

    let L = (textureLoad(froxelLightTexture, coord, 0).rgb +
             textureLoad(froxelLightTexture, cXP,   0).rgb +
             textureLoad(froxelLightTexture, cXM,   0).rgb +
             textureLoad(froxelLightTexture, cYP,   0).rgb +
             textureLoad(froxelLightTexture, cYM,   0).rgb) * 0.2;

    let dz = sliceDzLog(z, slices, froxelParams.nearPlane, froxelParams.farPlane);

    // 1) In-scattering integration with multiple scattering boost:
    // dS = T * (L * sigmaS) * dz * boost

    // Cuando T es alto (zona poco densa): msBoost completo
    // Cuando T es bajo (zona muy densa): msBoost se acerca a 1.0 (sin boost)
    let msBoost = mix(volumetricSettings.multipleScatteringBoost, 1.0, 1.0 - T);
    S += T * (L * sigmaS * msBoost) * dz;

    // 2) Transmittance update:
    // T *= exp(-sigmaT * dz)
    T *= exp(-sigmaT * dz);

    // Guardamos resultado integrado hasta este slice
    // RGB = scattering integrado
    // A   = transmittance
    textureStore(froxelIntegratedTexture, coord, vec4<f32>(S, T));
  }
}