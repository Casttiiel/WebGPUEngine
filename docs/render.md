# Render Module Architecture

The renderer is a WebGPU **deferred, GPU-driven** pipeline. Three classes carry most of the work:

| Class              | File                                                    | Role                                                           |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| `ModuleRender`     | `src/modules/core/ModuleRender.ts`                      | Frame orchestration + post-processing chain (camera components) |
| `DeferredRenderer` | `src/renderer/core/pipeline/DeferredRenderer.ts`        | Shadows, depth prepass, G-Buffer, lighting, water, OIT, SSR, volumetrics |
| `RenderManagerV2`  | `src/renderer/core/managers/RenderManagerV2.ts`         | Render keys, GPU frustum + HZB culling, indirect draws, state sorting |

Every post-process effect is an **optional component on the `MainCamera` entity**. If the component is absent (or disabled by quality settings) the step is skipped.

---

## Feature Summary

**Geometry & culling**
- Depth prepass (early-Z) → G-Buffer, with alpha-mask and PSX-dither variants
- GPU frustum culling (compute) + **HZB occlusion culling** using the previous frame's depth pyramid; indirect draws
- CPU frustum culling for shadow cameras and as fallback
- Instancing (`gbuffer_instanced`, `shadows_instanced`), skinned meshes (+ skinned velocity), terrain chunks with LOD, GPU grass (mesh / instanced / billboard with crossfade)
- KTX2 textures, texture streaming (`TextureStreamingManager`), mip generation (incl. normal-map aware)

**Materials** — metallic/roughness PBR (Cook-Torrance GGX + Smith + Schlick), normal maps, POM, triplanar (local/world), procedural stone, terrain splat, deferred decals (flat / multiface / cracks), dithered transparency.

**Lighting**
- IBL: diffuse irradiance + prefiltered specular with BRDF LUT (split-sum)
- Reflection probes with parallax-corrected cubemaps (`pcc.wgsl`), SH L2 irradiance (`SHProjector`), auto-placement and 2-probe blending (`ProbeManager`)
- Directional light with **CSM** (1–3 cascades, blended splits)
- Tiled point/spot lights (compute culling, 16×16 tiles) for shadowless lights
- Shadowed point (cube) and spot lights rendered as light volumes
- Area lights (rect/disk, "most representative point" — Karis 2013)
- Procedural sky with atmospheric scattering, procedural sky cubemap, volumetric clouds (3D noise + temporal reprojection)

**Screen-space** — GTAO / SSAO (compute, temporal), contact shadows (directional), stochastic SSR (compute, denoise + temporal).

**Transparency** — Water hybrid pass (own G-Buffer, deferred-lit, absorption + Fresnel composite), forward transparent pass (particles, trails), **Weighted-Blended OIT** glass with screen-space refraction.

**Volumetrics** — Froxel volumetric scattering (directional/point/spot injection, self-occlusion), fog volumes (box/sphere), height fog, atmospheric fog, multi-scatter fog, god rays.

**Post-processing** — bloom (with **lens dirt**), motion blur (per-object velocity), heat distortion, shockwave, DOF (CoC + near/far blur), auto exposure, lens flare, TAA / TSR, ACES tone mapping, palette quantize, FSR 1 (EASU + RCAS), FXAA, SMAA 1x / T2x, vignette, chromatic aberration, film grain, speed lines.

---

## Frame Pipeline

### `ModuleRender.generateFrame()`

```
beginFrame
├─ camera jitter (if smaa_t2x | taa | tsr)
├─ GPU frustum culling + tiled light culling
├─ DeferredRenderer.generateShadowMaps()     // directional CSM, shadowed spot, shadowed point
├─ DeferredRenderer.render(camera)            // see below → rtAccLight (HDR)
│
├─ velocity buffer (camera + per-object + skinned)   // when temporal AA / motion blur present
├─ height_fog → atmospheric_fog
├─ bloom (+ lens dirt)
├─ motion_blur
├─ distortions → shockwave
├─ depth_of_field
├─ auto_exposure (luminance histogram → adapt)
├─ god_rays → fog_scatter → lens_flare
├─ tsr | taa
├─ view-model pass (after TAA/TSR so the weapon doesn't ghost)
├─ tone_mapping (HDR → LDR, uses auto-exposure)
├─ palette_quantize → fsr
├─ fxaa → smaa → smaa_t2x
├─ vignette → chromatic_aberration → film_grain → speed_lines_vfx
├─ UI composited on top
└─ present
```

### `DeferredRenderer.render()`

```
0. HZB occlusion culling (previous frame's pyramid)
1. Depth prepass (SOLIDS)
2. Build HZB from this frame's depth (for next frame)
3. G-Buffer (SOLIDS) → copy albedo/normal → Decals
4. AO (GTAO/SSAO) + contact shadows
5. Lighting accumulation (renderAccLight):
     ambient diffuse (irradiance / probes) → directional (CSM) → area lights
     → tiled point/spot → shadowed point → shadowed spot
     → procedural sky cubemap (only if atmospheric fog needs it) → skybox → volumetric clouds
6. Water hybrid pass (skipped when no water): snapshot → water G-Buffer → water lighting → composite
7. Transparent pass (TRANSPARENT)
8. Copy rtAccLight → refraction buffer → OIT gather (GLASS) → OIT compose
9. SSR compute → ambient specular (SSR blended with prefiltered env via BRDF LUT)
10. Froxel volumetric scattering (if enabled)
→ returns rtAccLight
```

Ambient lighting is split in two (diffuse in step 5, specular in step 9) so SSR can run as a compute pass between them and the specular composite has the full SSR result: surfaces with a valid hit get SSR, rough surfaces or misses fall back to the prefiltered cubemap.

---

## G-Buffer

| Target       | Content                                | Format (ULTRA)  |
| ------------ | -------------------------------------- | --------------- |
| albedo       | RGB albedo, A metallic                 | `rgba8unorm`    |
| normal       | RGB world normal, A roughness          | `rgba16float`   |
| linear depth | linear view depth                      | `r16float`      |
| depth        | hardware depth (from prepass)          | depth format    |

Water writes to a separate water G-Buffer so it can be lit with the same deferred passes and composited over the opaque scene.

---

## Lighting

### Directional light + CSM

`DirectionalLightComponent` (`src/components/render/DirectionalLightComponent.ts`)

- `cascadeCount` 1–3; splits are a lambda blend between uniform and logarithmic (`cascadeLambda`, 0 = uniform, 1 = log).
- Each cascade halves the base resolution (minimum 256). Base resolution comes from `directionalShadowMapResolution` in the quality preset (256 on LOW, 2048 on ULTRA).
- The CSM shader (`common/lighting/csm.wgsl`) is always used, even with one cascade; a 10% blend region around splits removes hard transitions.
- Filtering: comparison sampler + rotated Poisson PCF with slope-scaled bias (`common/lighting/shadows.wgsl`).
- PSX variants (`directional_light_csm_psx`, `point_light_shadow_psx`) are selected when `ditheringMode === 'psx'`.

### Point / spot lights

- **Shadowless** lights go through `TiledLightManager`: shared storage buffers, a compute pass builds per-tile light lists, one full-screen pass shades them.
- **Shadowed** lights render light volumes (`pointLightsWithShadows`, `spotLightsWithShadows`): point lights use cube shadow maps, spot lights a 2D map. Shadow maps are only regenerated for visible lights.

### Area lights

`area_light.fs` — rectangle/disk lights using Karis' most-representative-point for specular. No shadows.

### Ambient / IBL / probes

- `AmbientLight` applies diffuse irradiance and, after SSR, prefiltered specular (max mip 7) with the BRDF LUT.
- `ReflectionProbeComponent` bakes a cubemap + SH L2 irradiance. `ProbeManager` picks the two dominant probes for the player position and blends them. Probes are applied by player position, not per pixel.

### Sky & clouds

`Skybox` / `skybox_scattering` (atmospheric scattering), `ProceduralSkyCubemap` (consumed by atmospheric fog), `VolumetricClouds` (3D noise texture from `CloudNoiseTexture3D`, raymarch + temporal pass + composite).

---

## Screen-Space Effects

### Ambient occlusion — `AmbientOcclusionComponent`

`mode: 'gtao' | 'ssao'` (compute). Runs at `aoScale` resolution, bilateral blur (`ao_blur.cs`) + temporal accumulation. Output is consumed by the ambient pass as AO / micro-shadow.

### Contact shadows — `ContactShadowsComponent`

Screen-space ray march toward the directional light only.

### SSR — `ScreenSpaceReflections`

Stochastic, compute-based (`ssr.cs` → `ssr_denoise.cs` → `ssr_temporal.cs`):

- Hierarchical ray march against depth, GGX-importance-sampled directions driven by roughness.
- Spatial denoise + temporal reprojection.
- Runs at `ssrScale` resolution; disabled on LOW.
- Composite happens in the ambient specular pass, where misses and rough surfaces fall back to the environment cubemap with Fresnel and the BRDF LUT.

---

## Post-Processing Notes

### Bloom + lens dirt — `BloomComponent`

Bright-pass filter (`bloom_filter.tech`, thresholds + emissive boost from the G-Buffer) → Kawase blur → additive combine onto the HDR buffer (`bloom_combine_simple`).

**Lens dirt** is part of the bloom combine, not a separate pass. The dirt mask modulates only the bloom layer:

```
result += bloom * intensity * (1 + dirt * lensDirtIntensity)
```

So dirt stays invisible in dark frames and shows up only where bright light hits the lens (UE-style). It costs one extra texture sample in a pass that already runs.

| Prefab field         | Default | Notes                                                       |
| -------------------- | ------- | ----------------------------------------------------------- |
| `thresholdMin`       | 12.0    | Bright-pass lower threshold                                 |
| `thresholdMax`       | 0.7     | Bright-pass upper threshold                                 |
| `emissiveFactor`     | 2.0     | Emissive boost into the bright-pass                         |
| `intensity`          | 1.0     | Bloom weight                                                |
| `lensDirtIntensity`  | 0.0     | 0 = off; scale depends on texture brightness (`lens_dirt.jpg` is dark: ~30–60) |
| `lensDirtTexture`    | `lens_dirt.jpg` | Texture path (black = clean lens, 16:9 recommended). Sampled through its sRGB view so it is linear before modulating the HDR bloom |

```json
"bloom": { "lensDirtIntensity": 40.0 }
```

All fields are also editable in the debug menu (Bloom folder).

`BloomGaussianComponent` (Gaussian blur, `bloom_combine.tech`) and `GlobalBloomComponent` (CoD:AW compute downsample/upsample) also exist but are not created by the loader for the `bloom` key; neither supports lens dirt.

### Temporal AA / upscaling

- `taa` — temporal accumulation at native resolution.
- `tsr` — temporal upscaling; the scene renders at a lower internal resolution and the view model uses the output resolution.
- `fsr` — spatial FSR 1 (EASU + RCAS sharpening) after tone mapping.
- `smaa_t2x` — SMAA with temporal resolve.

Jitter is enabled automatically when any of `smaa_t2x`, `taa` or `tsr` is present.

### Tone mapping & exposure

`tone_mapping.fs` implements ACES. `AutoExposureComponent` builds a luminance histogram in compute and adapts over time; tone mapping and god rays read the adapted exposure.

---

## RenderManagerV2

- **Render keys** (`RenderKeyManager`): one per (mesh, material, transform). Shadow casters get an extra key with the material's shadow variant.
- **Culling layers**:

| Layer                     | Class               | Used for                                                    |
| ------------------------- | ------------------- | ----------------------------------------------------------- |
| GPU frustum (primary)     | `GPUCullingManager` | Main camera — compute dispatch into indirect draw buffers   |
| HZB occlusion (layered)   | `HZBCullingPass`    | Main camera — tests GPU-visible set against last frame's HZB |
| CPU frustum               | `CPUCullingManager` | Shadow cameras; fallback when GPU culling is unavailable    |

- **State management** (`RenderStateManager`): redundant pipeline / vertex buffer / bind group changes are skipped; keys are sorted per category.
- **Categories** (`RenderCategory`): SOLIDS, DECALS, WATER, TRANSPARENT, GLASS, DISTORSIONS, SHADOWS, VIEW_MODEL.

---

## Quality Settings

`src/core/engine/QualitySettings.ts` — presets `LOW`, `MEDIUM`, `HIGH`, `ULTRA` (default ULTRA). Main knobs:

| Setting                          | LOW   | ULTRA |
| -------------------------------- | ----- | ----- |
| `renderResolution`               | 0.8   | 1.0   |
| `enableBloom` / `bloomNumMips`   | off / 0 | on / 8 |
| `enableAO` / `aoScale` / samples | off   | on / 0.5 / 16 |
| `ssrEnabled` / `ssrScale`        | off   | on / 0.5 |
| `directionalShadowMapResolution` | 256   | 2048  |
| `enableMotionBlur`               | off   | on    |

Plus texture formats per render target (`albedoTexture`, `normalTexture`, `linearDepthTexture`, `hdrTexture`, …), `meshTextureFilter`, `useKTX2` and `ditheringMode` (`'off' | 'psx'`).

---

## SamplerLibrary

Pre-created samplers shared by the whole renderer — **never create samplers manually**.

| Getter                                   | Use                                              |
| ---------------------------------------- | ------------------------------------------------ |
| `SamplerLibrary.simpleSampler`           | Linear clamp — general post-process              |
| `SamplerLibrary.bloom`                   | Linear clamp + mips — bloom, lens dirt           |
| `SamplerLibrary.ambientOcclusionSampler` | AO passes                                        |
| `SamplerLibrary.shadows`                 | Comparison sampler for shadow maps               |
| `SamplerLibrary.anisotropic16x`          | Surface textures (only anisotropic preset)       |
| `SamplerLibrary.skybox`                  | Skybox / cubemap                                 |
| `SamplerLibrary.environmentCubemap`      | IBL specular                                     |
| `SamplerLibrary.nonFilteringSampler`     | Nearest — G-Buffer / depth reads                 |
| `SamplerLibrary.froxelRaymarchSampler`   | Froxel volumetric raymarch                       |
| `SamplerLibrary.nearestRepeat`           | Nearest repeat — noise / LUT textures            |

---

## Known Gaps / Roadmap

Features common in state-of-the-art engines (and/or present in three.js WebGPU examples) that the renderer does not have yet:

- **GI**: dynamic diffuse GI (DDGI-style irradiance volume, SSGI or VXGI), baked lightmaps
- **Lights**: LTC area lights (+ shadows), IES profiles, spot cookies/projectors, clustered (3D) light culling
- **Shadows**: PCSS or VSM/EVSM, screen-space shadows for all lights, colored/translucent shadows, static shadow caching / virtual shadow maps
- **Materials**: clearcoat, sheen, physical transmission + thickness, specular anisotropy, iridescence, dispersion, subsurface scattering, alpha hash / alpha-to-coverage
- **Geometry**: mesh LOD with dither crossfade, morph targets, meshlets / cluster culling, impostors
- **Post / output**: 3D LUT color grading, AgX / Khronos Neutral tone mapping, HDR display output, reversed-Z, bokeh DOF, post-process outlines
- **Water / VFX**: FFT/Gerstner ocean, caustics, underwater, planar reflections, soft particles, depth-buffer particle collisions, particle sorting, wetness
- **Infrastructure**: render graph with automatic resource aliasing, render bundles, dynamic resolution driven by GPU frame time
