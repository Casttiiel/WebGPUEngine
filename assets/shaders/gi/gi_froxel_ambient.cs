// ---------------------------------------------------------------------------
// GI ambient in the froxel fog (RealtimeGI.injectFroxelAmbient, FroxelVolumetricScattering
// ambient injector): one thread per froxel, a step of the light volume's ping-pong. Replaces
// the constant ambient (set to 0 while this runs) with the GI probes at the froxel's jittered
// sample: the irradiance arriving from beyond the froxel (normal facing away from the camera),
// i.e. the light that forward scattering sends toward the viewer, / π → radiance. Where the GI
// volumes don't reach (far froxels, sky) the sky irradiance fills in — the same light probe rays
// get when they escape, so there is no step at the edge of a cascade (the fog's old constant is
// ~4× brighter and showed every cascade boundary as a band over the sky). a passes through.
// ---------------------------------------------------------------------------

#include "common/uniforms"
#include "common/structs"
#include "common/core/constants"
#include "common/volumetric/structs"
#include "common/volumetric/froxel"
#include "common/probes"
#include "gi/common/gi_common"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var<uniform> froxelParams: FroxelUniforms;
@group(1) @binding(1) var<uniform> volumetricSettings: VolumetricUniforms;

@group(2) @binding(0) var froxelLightTexture: texture_3d<f32>;
@group(2) @binding(1) var froxelLightOutput: texture_storage_3d<rgba16float, write>;

@group(3) @binding(0) var<uniform> giParams: GIParams;
@group(3) @binding(2) var<storage, read> probeSet: ProbeSet;
@group(3) @binding(4) var<storage, read> giProbeState: array<vec4<f32>>;
@group(3) @binding(5) var giIrradianceAtlas: texture_2d<f32>;
@group(3) @binding(6) var giVisibilityAtlas: texture_2d<f32>;
@group(3) @binding(7) var giSampler: sampler;
@group(3) @binding(8) var<storage, read> giVolumes: array<GIVolume>;

#include "gi/common/gi_sampling"

/** Sky irradiance facing `n` (gi_shading.wgsl giSkyRadiance × π). */
fn skyIrradiance(n: vec3<f32>) -> vec3<f32> {
    var e: vec3<f32>;
    if (probeSet.hasGlobalSH != 0u) {
        e = evalSHProbe(probeSet.globalSH, n);
    } else {
        let hemi = n.y * 0.5 + 0.5;
        e = mix(vec3<f32>(0.10, 0.07, 0.04), vec3<f32>(0.38, 0.50, 0.65), hemi);
    }
    return e * probeSet.ambientScale * giParams.tuning.y;
}

@compute @workgroup_size(8, 8, 4)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = vec3<u32>(froxelParams.dimensions.xyz);
    if (any(gid >= dims)) { return; }
    let coord = vec3<i32>(gid);
    let existing = textureLoad(froxelLightTexture, coord, 0);

    let froxelVS = froxelCoordToViewSpace(
        vec3<f32>(gid) + froxelParams.jitter.xyz,
        froxelParams.dimensions.xyz,
        froxelParams.depthDistScale,
        froxelParams.depthDistB,
        camera.invProjection
    );
    let pos = (camera.invView * vec4<f32>(froxelVS, 1.0)).xyz;
    let away = normalize(pos - camera.cameraPosition.xyz);

    let gi = giSampleIrradiance(pos, away, -away);
    let E = gi.rgb * giParams.tuning.z + skyIrradiance(away) * (1.0 - gi.a);
    let radiance = E * GI_INV_PI;
    let ambient = radiance * volumetricSettings.ambientVolumetricIntensity;
    textureStore(froxelLightOutput, coord, vec4<f32>(existing.rgb + ambient, existing.a));
}
