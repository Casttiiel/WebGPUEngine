// Single Layer Water – Composite Pass
// Implements a UE5-style Single Layer Water approximation:
//   1. Beer–Lambert absorption  — volume colour/depth
//   2. Scattering               — subsurface tint
//   3. Screen-space refraction  — UV offset from surface normal
//   4. Fresnel (Schlick)        — reflection vs. transmission weight
//   5. IBL env cubemap          — specular reflection
//
// The water fragment shader (water_gbuffer.fs) runs first and writes raw PBR
// properties into the dedicated water GBuffer.  This fullscreen pass then reads
// those properties together with a pre-water scene snapshot and composites the
// final result back into the main accLight buffer.
//
//   group(0) binding 0 — CameraUniforms
//   group(1) binding 0 — txSceneBeforeWater   lit scene snapshot (no water)
//   group(1) binding 1 — txWaterAlbedo        base colour (RGB) + metallic (A)
//   group(1) binding 2 — txWaterNormal        oct-encoded normal (RG) + roughness (B)
//   group(1) binding 3 — txWaterDepth         water surface linear depth (0 = no water)
//   group(1) binding 4 — txSolidDepth         opaque scene linear depth
//   group(1) binding 5 — txEnvCubemap         IBL environment cubemap
//   group(1) binding 6 — samplerState         bilinear / trilinear sampler
//   group(1) binding 7 — envSampler           cubemap sampler
//   group(1) binding 8 — txWaterLit           water surface after ambient + directional lighting

#include "common/uniforms"
#include "common/octahedral"
#include "common/math/coordinates"

@group(0) @binding(0) var<uniform> camera:          CameraUniforms;

@group(1) @binding(0) var txSceneBeforeWater: texture_2d<f32>;
@group(1) @binding(1) var txWaterAlbedo:      texture_2d<f32>;
@group(1) @binding(2) var txWaterNormal:      texture_2d<f32>;
@group(1) @binding(3) var txWaterDepth:       texture_2d<f32>;
@group(1) @binding(4) var txSolidDepth:       texture_2d<f32>;
@group(1) @binding(5) var txEnvCubemap:       texture_cube<f32>;
@group(1) @binding(6) var samplerState:       sampler;
@group(1) @binding(7) var envSampler:         sampler;
@group(1) @binding(8) var txWaterLit:         texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {

    // textureSampleLevel (explicit LOD) does not require uniform control flow, so
    // all texture reads below are safe inside non-uniform branches.

    let waterLinDepth = textureSampleLevel(txWaterDepth, samplerState, uv, 0.0).r;

    // ── Passthrough for non-water pixels ─────────────────────────────────────
    if (waterLinDepth <= 0.0) {
        return textureSampleLevel(txSceneBeforeWater, samplerState, uv, 0.0);
    }

    // ── Unpack water GBuffer ──────────────────────────────────────────────────
    let albedoData     = textureSampleLevel(txWaterAlbedo, samplerState, uv, 0.0);
    let waterBaseColor = albedoData.rgb;  // water tint / foam colour

    let normalData = textureSampleLevel(txWaterNormal, samplerState, uv, 0.0);
    let surfNormal = octahedral01ToNormal(normalData.xy);
    let roughness  = normalData.z;

    // ── Volume depth (world-space distance beneath the surface) ───────────────
    // solidLinDepth = depth of the opaque scene behind the water surface
    let solidLinDepth = textureSampleLevel(txSolidDepth, samplerState, uv, 0.0).r;
    let waterVolDepth = max(0.0, solidLinDepth - waterLinDepth) * camera.cameraFar;

    // ── Beer-Lambert absorption ───────────────────────────────────────────────
    // Each channel decays at a different rate: red absorbed fastest, blue slowest.
    // This produces the characteristic blue-green tint of deep water.
    let absorptionCoeff = vec3<f32>(0.45, 0.15, 0.05);
    let absorption      = exp(-absorptionCoeff * waterVolDepth);

    // ── Scattering (exponential, not linear) ─────────────────────────────────
    // Models how light scatters inside the volume before reaching the camera.
    // Using 1 - exp(-k*d) gives a smooth shallow→deep transition without the
    // hard knee that saturate(d/maxD) produces at the threshold.
    let scatterCoeff    = 0.35;
    let scatterAmount   = 1.0 - exp(-scatterCoeff * waterVolDepth);
    let scatterTint     = waterBaseColor * scatterAmount;

    // ── Screen-space refraction ───────────────────────────────────────────────
    // Offset the background sample UV by the surface normal (XY component only).
    // Guard: only apply offset if the refracted pixel is actually behind the surface
    // (avoids sampling above-water geometry through the water plane).
    let refractionStrength = 0.025;
    let refractUV          = clamp(uv + surfNormal.xy * refractionStrength,
                                   vec2<f32>(0.001), vec2<f32>(0.999));
    let refractedSolidDepth = textureSampleLevel(txSolidDepth, samplerState, refractUV, 0.0).r;
    let finalBGUV  = select(uv, refractUV, refractedSolidDepth >= waterLinDepth);
    let sceneColor = textureSampleLevel(txSceneBeforeWater, samplerState, finalBGUV, 0.0).rgb;

    // ── Transmitted background ────────────────────────────────────────────────
    // Beer-Lambert attenuates what reaches us; scattering adds the water tint.
    // (1 - scatterAmount) ensures energy conservation: more scatter → less bg.
    let transmitted = sceneColor * absorption * (1.0 - scatterAmount) + scatterTint;

    // ── Fresnel (Schlick approximation) ───────────────────────────────────────
    // Water IOR ≈ 1.33  →  F0 = ((n-1)/(n+1))^2 ≈ 0.02
    let worldPos = getWorldCoords(uv, waterLinDepth, camera);
    let V        = normalize(camera.cameraPosition.xyz - worldPos);
    let NdotV    = max(dot(surfNormal, V), 0.0);
    let fresnel  = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

    // ── IBL environment reflection ────────────────────────────────────────────
    // Use actual cubemap mip count so roughness maps correctly across all presets.
    let R      = reflect(-V, surfNormal);
    let envMip = roughness * f32(textureNumLevels(txEnvCubemap) - 1u);
    let reflColor = textureSampleLevel(txEnvCubemap, envSampler, R, envMip).rgb;

    // ── Foam / shoreline ─────────────────────────────────────────────────────
    // Thin water (<0.3 world units) gets a white foam overlay, matching the
    // shoreline break where turbulence aerates the water surface.
    let foamColor    = vec3<f32>(0.95, 0.97, 1.0);
    let foamStrength = smoothstep(0.0, 0.3, 1.0 - waterVolDepth);
    let foamMask     = foamStrength * 0.85; // max opacity cap

    // ── Composite ─────────────────────────────────────────────────────────────
    // Fresnel-blend: normal incidence → see transmitted background, grazing → mirror reflection.
    var finalColor = mix(transmitted, reflColor, fresnel);

    // Add the fully-lit water surface (ambient IBL diffuse + directional light diffuse+specular).
    // This is the deferred lighting result evaluated on the water GBuffer, equivalent to what
    // opaque surfaces receive.  It is added on top of the Fresnel blend because the surface
    // PBR terms (NdL, VdH Fresnel, GGX specular) have already been computed in the lighting
    // passes and are independent of the view-angle Fresnel transmission/reflection split.
    let litSurface = textureSampleLevel(txWaterLit, samplerState, uv, 0.0).rgb;
    finalColor += litSurface;

    // Foam / shoreline on top of everything.
    finalColor = mix(finalColor, foamColor, foamMask);

    return vec4<f32>(finalColor, 1.0);
}
