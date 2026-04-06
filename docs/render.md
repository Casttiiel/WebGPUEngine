# Render Module Architecture

The WebGPU Engine's rendering system is built around a sophisticated modular architecture that delivers high-performance 3D graphics through WebGPU. The system consists of three primary components that work in concert to provide physically-based rendering with advanced post-processing effects and performance optimizations.

## System Overview

The render module implements a modern deferred rendering pipeline with the following key features:

- **Deferred Rendering**: G-Buffer based approach for efficient multi-light scenarios
- **Physically-Based Rendering (PBR)**: Metallic-roughness workflow with Image-Based Lighting (diffuse irradiance + specular env/BRDF-LUT)
- **Modular Post-Processing**: Extensible effects pipeline including compute-based bloom, tone mapping, FXAA/SMAA/TAA anti-aliasing, ambient occlusion, SSR, DOF, motion blur, god rays, lens flare, volumetrics, and more
- **Performance Optimization**: GPU-based frustum culling (primary) + HZB occlusion culling + CPU culling fallback; SamplerLibrary for GPU resource optimization
- **Transparent & Glass**: Water/transparent pass (TRANSPARENT category), OIT Weighted-Blended glass pass (GLASS category) with screen-space refraction
- **Quality Management**: Adaptive rendering quality based on performance requirements with four quality presets
- **WebGPU Optimization**: Optimized for 2K@60fps performance with dynamic resolution scaling and efficient resource management

### SamplerLibrary - GPU Resource Optimization

The engine features a comprehensive sampler library system that eliminates redundant GPU resource creation:

- **Centralized Management**: Pre-created samplers for all common use cases
- **Performance Optimization**: Avoids expensive GPU sampler creation during runtime
- **10 Specialized Samplers**: `simpleSampler`, `bloom`, `ambientOcclusionSampler`, `shadows`, `anisotropic16x`, `skybox`, `environmentCubemap`, `nonFilteringSampler`, `froxelRaymarchSampler`, `nearestRepeat`
- **Single Anisotropic Preset**: `anisotropic16x` — the only anisotropic sampler (16×)
- **Memory Efficient**: Proper initialization and cleanup lifecycle

```typescript
// SamplerLibrary usage examples
SamplerLibrary.initialize(); // Called during engine startup
const postProcessSampler = SamplerLibrary.simpleSampler; // For FXAA, bilateral filter
const bloomSampler = SamplerLibrary.bloom; // For bloom post-processing
const aoSampler = SamplerLibrary.ambientOcclusionSampler; // For AO techniques
const shadowSampler = SamplerLibrary.shadows; // Comparison sampler for shadow maps
const anisotropicSampler = SamplerLibrary.anisotropic16x; // High-quality anisotropic filtering
const skyboxSampler = SamplerLibrary.skybox; // For skybox / cubemap sampling
const envSampler = SamplerLibrary.environmentCubemap; // For IBL environment cubemap
const nearestSampler = SamplerLibrary.nonFilteringSampler; // Nearest neighbor (no filter)
const volumetricSampler = SamplerLibrary.froxelRaymarchSampler; // For froxel volumetrics
const nearestRepeatSampler = SamplerLibrary.nearestRepeat; // Nearest + repeat wrapping
```

### Quality Settings System

The engine includes comprehensive quality management with four preset levels:

- **LOW**: 75% resolution, no bloom/AO, MSAA 1x, optimized for lower-end hardware
- **MEDIUM**: 85% resolution, limited effects, MSAA 2x, balanced performance
- **HIGH**: 100% resolution, full effects, MSAA 4x, high-quality visuals
- **ULTRA**: 100% resolution, maximum effects, MSAA 4x, highest visual quality

### Ambient Lighting and Specular IBL

The ambient light pass runs in two sub-passes:

1. **Diffuse pass** (`renderAccLight` → `ambientLight.render()`): Applies diffuse irradiance from the environment cubemap using the precomputed irradiance map, plus the directional light, tiled point/spot lights, and skybox. This is the main lighting accumulation pass.

2. **Specular pass** (`ambientLight.renderSpecular()`): After the SSR compute step, blends SSR hit colors with the environment cubemap specular using the BRDF LUT (split-sum approximation). This ensures energy-conserving PBR specular — surfaces with a valid SSR hit get screen-space reflections; surfaces with roughness too high or no SSR hit fall back to the prefiltered env cubemap.

The split between diffuse and specular passes allows SSR to run as a compute shader between them, so the specular composite has access to the full SSR result.

---

### Screen Space Reflections (SSR)

The engine implements a physically-based SSR system for realistic surface reflections, fully integrated with the deferred PBR pipeline and designed for UE5-level quality. Key features and implementation details:

- **Hierarchical Ray Marching**: Efficient screen-space ray tracing using hierarchical steps for fast and robust intersection with the scene depth buffer. The SSR shader performs multiple steps per ray, with early exit on hit or max steps.
- **PBR/BRDF Integration**: Reflections use the same Cook-Torrance BRDF as direct lighting, including GGX NDF, Smith geometry, and Schlick Fresnel. The SSR shader samples the BRDF LUT using correct UE5-style coordinates (NdotV, roughness²) for energy-conserving reflection color.
- **Roughness and Fresnel**: Reflection strength and sharpness are modulated by surface roughness (using roughness² for correct microfacet distribution) and Schlick Fresnel, matching UE5's approach. This ensures physically plausible blending between mirror and diffuse.
- **BRDF LUT Usage**: The SSR shader uses the precomputed BRDF LUT for split-sum approximation, with correct input coordinates (NdotV, roughness²) for specular response. This matches the PBR pipeline and ensures energy conservation.
- **Environment Fallback/Blending**: When SSR rays miss or hit invalid regions, the shader blends with the environment map (skybox or IBL) using a physically-based Fresnel factor. This avoids harsh cutoffs and ensures smooth transitions between SSR and environment reflections.
- **Compositing Pipeline**: SSR is composited after lighting accumulation, using a dedicated pass that blends SSR results with the lighting buffer. The result is then passed to post-processing (bloom, tone mapping, FXAA).
- **Quality Controls**: All SSR parameters (step size, max steps, max distance, thickness, intensity) are exposed via the debug UI and adapt to quality settings. Lower quality reduces steps and distance for performance.
- **Debug UI Integration**: Real-time adjustment of SSR parameters is available through the engine's debug UI, allowing for rapid tuning and visual debugging. Reflection mask and result can be visualized for development.
- **Performance Optimizations**: The SSR shader uses early ray termination, hierarchical stepping, and optimized texture sampling. Separate command encoders are used to avoid resource conflicts. All samplers are sourced from the SamplerLibrary for optimal reuse.
- **WebGPU Best Practices**: The SSR system is fully asynchronous, respects device limits, and is optimized for 2K@60fps on modern browsers. All GPU resources are properly managed and disposed.

**SSR Pipeline Overview:**

1. **SSR Pass**: Ray marching in screen space using G-Buffer (position, normal, roughness, metallic, depth) and lighting buffer. Reflection color is computed using PBR math and BRDF LUT.
2. **Reflection Mask**: A mask is generated to indicate valid SSR hits, used for compositing and debug visualization.
3. **Compositing**: SSR result is blended with the lighting buffer and environment using Fresnel and roughness. The final output is passed to post-processing.
4. **Debug/Quality**: All parameters are exposed in the debug UI and adapt to quality settings.

**SSR Shader Highlights:**

- Hierarchical ray marching with early exit
- Cook-Torrance BRDF (GGX, Smith, Schlick Fresnel)
- Correct BRDF LUT sampling (NdotV, roughness²)
- Reflection strength modulated by roughness and Fresnel
- Environment fallback with smooth blending
- Reflection mask for compositing and debug

**Best Practices:**

- Always use the SamplerLibrary for SSR samplers
- Expose all SSR parameters in the debug UI for tuning
- Use roughness² for all BRDF and reflection calculations
- Ensure SSR compositing occurs after lighting and before post-processing

This SSR implementation provides physically-based, high-quality reflections that match modern engines like Unreal Engine 5, with full integration into the deferred PBR pipeline and robust performance on the web.

---

### Compute-Based Bloom System

The engine features a state-of-the-art bloom implementation using WebGPU compute shaders:

- **Call of Duty: Advanced Warfare Technique**: Industry-proven algorithm implementation
- **Three-Phase Pipeline**: Progressive downsample → upsample → combine process
- **WebGPU Synchronization**: Separate command encoder submissions prevent race conditions
- **Adaptive Quality**: Dynamic mip count (3-8 range) based on quality settings
- **Memory Optimization**: Efficient texture reuse and proper resource cleanup
- **GPU Performance**: Compute shaders provide maximum throughput for bloom calculations

## ModuleRender

`ModuleRender` serves as the high-level coordinator for the entire rendering system, managing the rendering pipeline lifecycle and orchestrating the interaction between different rendering components.

### Core Responsibilities

#### 1. **Rendering Pipeline Management**

ModuleRender initializes and manages the `DeferredRenderer` instance, coordinates the main rendering loop execution, handles quality settings and performance adaptations, and manages the post-processing effects chain.

```typescript
export class ModuleRender extends Module {
  private deferred: DeferredRenderer;

  public async start(): Promise<boolean> {
    await this.deferred.load();
    this.onResolutionUpdated();

    // Initialize GPU Frustum Culling
    await RenderManager.getInstance().initialize();

    return true;
  }
}
```

#### 2. **Frame Generation Pipeline**

The main rendering pipeline executes in a specific order to ensure correct visual output:

```typescript
public generateFrame(): void {
  Render.getInstance().beginFrame();

  // 1. Get main camera entity
  const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
  let result: GPUTextureView;

  if (!mainCameraEntity) {
    // No 3D camera — output black texture (UI-only mode)
    result = this.createBlackTexture();
  } else {
    const camera = (mainCameraEntity.getComponent('camera') as CameraComponent).getCamera();
    camera.setViewport(Render.width, Render.height);

    // Enable / advance temporal jitter (SMAA T2x / TAA)
    const needsJitter =
      mainCameraEntity.hasComponent('smaa_t2x') || mainCameraEntity.hasComponent('taa');
    if (needsJitter) camera.nextJitter();

    // GPU frustum culling + tiled light culling
    RenderManager.getInstance().performCulling(camera);
    RenderManager.getInstance().performLightCulling(camera);

    // Shadow maps for all shadow-casting lights
    this.deferred.generateShadowMaps();
    RenderManager.getInstance().setCamera(camera);

    // Core deferred render:
    //   DepthPrepass → GBuffer → HZB build → Decals →
    //   AO → AccLight (diffuse) →
    //   Transparent (water) → copy→refraction →
    //   OIT gather (glass) → OIT compose →
    //   SSR compute → AccLight specular →
    //   Volumetrics
    result = this.deferred.render(mainCameraEntity);
  }

  // ── Post-processing chain (per-camera optional components) ──────────────
  if (mainCameraEntity) {
    // Velocity buffer for motion blur / TAA
    velocityMgr.generate(this.mainCamera, this.deferred.getGBufferBindGroup());

    result = heightFog.apply(result, gbuffer);           // Height-based fog
    result = atmosphericFog.apply(result, gbuffer);      // Atmospheric scattering
    result = bloom.apply(result, gbuffer);               // Compute-based bloom
    result = motionBlur.apply(result, gbuffer);          // Per-object motion blur

    this.distorsions.render(result, depthStencilView);   // Heat/refraction distortion overlays

    result = depthOfField.apply(result, gbuffer, linearDepth);   // Depth of field
    autoExposure.apply(result, dt);                              // Auto-exposure histogram
    result = godRays.apply(result, gbuffer);                     // Kawase god rays
    result = lensFlare.apply(result, gbuffer);                   // Lens flare

    result = taa.apply(result, linearDepth);                     // TAA (temporal accumulation)
    result = toneMapping.apply(result);                          // HDR → LDR tone mapping
    result = paletteQuantize.apply(result);                      // Optional palette quantization
    result = fsr.apply(result, encoder);                         // FSR upscale (EASU + RCAS)
    result = fxaa.apply(result);                                 // FXAA edge AA
    result = smaa.apply(result);                                 // SMAA 1x
    result = smaaT2x.apply(result, linearDepth);                 // SMAA T2x (temporal)
    speedLinesVFX.apply(result);                                 // Speed-lines overlay

    this.renderUIOnTexture(result);   // UI widgets composited on top
  }

  this.presentResult(result);
  Render.getInstance().endFrame();
}
```

> All post-processing steps are optional camera components. Absent or quality-disabled components are simply skipped.

#### 3. **Quality Management Integration**

ModuleRender integrates with the quality settings system to adapt rendering parameters:

```typescript
private applyBloomQualitySettings(bloom: BloomComponent): void {
  const qualitySettings = QualitySettings.getInstance();
  const bloomConfig = qualitySettings.getBloomConfig();

  if (bloomConfig.enabled) {
    bloom.setQuality(bloomConfig.quality);
    bloom.setIntensity(bloomConfig.intensity);
  }
}
```

**Bloom Integration:**
The system includes advanced compute-based bloom that adapts to quality settings through:

- **Adaptive Mip Count**: Quality settings control the number of downsampling steps (3-8 range)
- **Compute Shader Performance**: Uses WebGPU compute pipelines for maximum efficiency
- **Synchronization Architecture**: Separate command encoder submissions ensure proper execution order
- **Memory Management**: Dynamic bind group creation and efficient texture reuse

**SamplerLibrary Integration:**
All post-processing effects now use optimized samplers from the centralized library:

```typescript
// Components use pre-created samplers for optimal performance
const fxaaSampler = SamplerLibrary.simpleSampler; // For FXAA antialiasing
const bloomSampler = SamplerLibrary.bloom; // For bloom post-processing
const aoSampler = SamplerLibrary.ambientOcclusionSampler; // For ambient occlusion
const bilateralSampler = SamplerLibrary.simpleSampler; // For bilateral filtering
```

#### 4. **Debug Information**

The module provides comprehensive debug statistics for performance monitoring:

```typescript
private debugValues = {
  drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
  drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
  drawCallsDistorsions: { name: 'Draw Calls (Distorsions)', value: 0 },
  drawCallsDecals: { name: 'Draw Calls (Decals)', value: 0 },
  totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
  resolution: { name: 'Resolution', value: '0x0' },
};
```

## DeferredRenderer

`DeferredRenderer` implements the core deferred rendering pipeline, handling geometry rendering, lighting calculations, and G-Buffer management. This component is responsible for the multi-pass rendering approach that enables efficient lighting of complex scenes.

### Architecture Components

#### 1. **G-Buffer Layout**

The G-Buffer stores geometry information across multiple render targets:

```wgsl
struct FragmentOutput {
  @location(0) albedo: vec4<f32>;     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>;     // RGB: world normal, A: roughness
  @location(2) depth: f32;            // Linear depth (0-1)
}
```

#### 2. **Render Pass System**

The deferred renderer uses a modular render pass system managed by `RenderPassManager`:

```typescript
export class DeferredRenderer {
  private renderPassManager!: RenderPassManager;
  private gBufferPass!: GBufferPass;

  public render(camera: Entity): GPUTextureView {
    // 0. Depth prepass (hardware early-Z for GBuffer overdraw reduction)
    renderManager.setTechniqueOverride(depthPrepassTechnique, ...);
    this.renderPassManager.executePass('depth_prepass', RenderCategory.SOLIDS);
    renderManager.clearTechniqueOverride();

    // 1. G-Buffer pass — SOLIDS category; uses depth from prepass
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // 2. Build HZB pyramid for NEXT frame's occlusion culling
    this.hzbBuilder.build(encoder, depthTexture);

    // 3. Copy GBuffer textures; Decal pass
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // 4. Ambient occlusion (SSAO/SSGI compute)
    this.aoResult = this.renderAO(camera);

    // 5. Lighting accumulation: ambient IBL diffuse, directional, tiled point/spot lights, skybox
    this.renderAccLight();

    // 6. Water / transparent pass (TRANSPARENT category)
    //    — ensureWaterSceneBindGroup() lazily builds the water scene data bind group
    //      (linear depth + env cubemap) and sets it as passGroup3 in RenderManagerV2
    this.ensureWaterSceneBindGroup();
    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    // 7. Copy rtAccLight → rtGlassRefraction (for screen-space refraction in glass)
    encoder.copyTextureToTexture(rtAccLight, rtGlassRefraction, size);

    // 8. OIT glass pass (GLASS category; Weighted-Blended OIT)
    this.ensureOITGlassEnvBindGroup();
    this.renderPassManager.executePass('oit_gather', RenderCategory.GLASS);
    this.renderPassManager.executeOITComposePass(..., this.rtAccLight);

    // 9. SSR compute pass → then ambient specular (blends SSR + env cubemap BRDF-LUT)
    const ssr = this.ssr.generateSSR(rtAccLight, aoResult, gBufferComputeBindGroup, ...);
    this.ambientLight.renderSpecular(rtAccLight, ssr, aoResult, gBufferBindGroup);

    // 10. Froxel volumetric scattering (if enabled)
    this.froxelVolumetrics.renderVolumetrics(rtAccLight.getView(), gBufferBindGroup);

    return this.rtAccLight.getView();
  }
}
```

#### 3. **Resource Management**

The deferred renderer manages multiple render targets and GPU resources:

```typescript
private rtAccLight!: RenderTarget;         // Accumulated lighting (output from deferred pass)
private rtOITAccumulation!: RenderTarget;  // OIT weighted color accumulation
private rtOITRevealage!: RenderTarget;     // OIT revealage (alpha coverage)
private rtGlassRefraction!: RenderTarget;  // Copy of rtAccLight before glass pass (refraction source)
private rtCopyAlbedos!: RenderTarget;      // G-Buffer albedo copy (for decals)
private rtCopyNormals!: RenderTarget;      // G-Buffer normal copy (for decals)
private ssr!: ScreenSpaceReflections;      // SSR compute system
private froxelVolumetrics!: FroxelVolumetricScattering; // Froxel volumetric lighting
private waterSceneBindGroup: GPUBindGroup | null;   // Lazy: linear depth + env cube for water
private oitGlassEnvBindGroup: GPUBindGroup | null;  // Lazy: env cube + refraction buf for glass
```

#### 4. **Screen Space Reflections Integration**

SSR now runs as a **compute shader** between the main lighting pass and the ambient specular pass:

```typescript
// After OIT compose, inside DeferredRenderer.render():
const ssr = this.ssr.generateSSR(
  this.rtAccLight.getView(),
  this.aoResult,
  this.gBufferComputeBindGroup,   // COMPUTE-visibility bind group
  gBufferRTs.normals.getView(),
  gBufferRTs.linearDepth.getView(),
);
// SSR result is then consumed by the specular pass:
this.ambientLight.renderSpecular(this.rtAccLight.getView(), ssr, this.aoResult, this.gBufferBindGroup);
```

The final image in `rtAccLight` contains diffuse + direct lighting + OIT glass + SSR-blended specular IBL.

#### 5. **Lighting System Integration**

The renderer integrates multiple lighting systems:

```typescript
private renderAccLight(): void {
  // Ambient IBL diffuse pass (irradiance cubemap; specular is deferred until after SSR)
  this.ambientLight.render(this.rtAccLight.getView(), this.gBufferWithAOBindGroup);

  // Directional light + PCF shadow map
  this.directionalLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);

  // Area lights (rect/disk area lights)
  this.areaLight?.render(this.rtAccLight.getView(), this.gBufferBindGroup);

  // Tiled point and spot lights (clustered/tiled deferred)
  this.tiledLightManager.render(
    this.rtAccLight.getView(), this.tiledLightMesh, this.tiledLightTechnique, ...
  );

  // Per-light shadow variants (point lights with shadow maps)
  this.renderPassManager.executePass('pointLights');
  this.renderPassManager.executePass('spotLights');

  // Skybox rendered last (uses depth buffer for correct blending)
  this.skybox.render(this.rtAccLight.getView(), depthView);
}
```

#### 5. **MSAA Support**

The renderer includes comprehensive MSAA support with manual depth resolve:

```typescript
// Resolve MSAA depth to single-sample depth for skybox
if (msaaLevel > 1) {
  this.depthResolver.resolve(gBufferDepthTextures.msaaDepth, gBufferDepthTextures.singleDepth);
}
```

### Quality Configuration Integration

The deferred renderer adapts to quality settings:

```typescript
public create(width: number, height: number) {
  const qualitySettings = QualitySettings.getInstance();
  const postProcessingFormats = qualitySettings.getPostProcessingFormats();
  const msaaLevel = qualitySettings.getMSAALevel();
  const gBufferQuality = qualitySettings.getGBufferTextureQuality();
  const enableMSAA = msaaLevel > 1;
  const formats = GBufferQualityConfig.getFormats(gBufferQuality);

  // Configure render targets based on quality settings
  this.rtAccLight.createRT(
    'acc_light.dds',
    width,
    height,
    postProcessingFormats.toneMappingTexture,
    enableMSAA
  );
}
```

## RenderManagerV2

`RenderManagerV2` serves as the bridge between the ECS system and the GPU, managing render keys, performing culling operations, and coordinating draw calls.

### Core Architecture

#### 1. **Render Key Management**

The system organizes renderable objects through a render key system:

```typescript
export class RenderManagerV2 {
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private cpuCuller: CPUCullingManager | null = null;  // Shadow cameras & fallback
  private gpuCuller: GPUCullingManager | null = null;  // Main camera (PRIMARY)
  private hzbCullingPass: HZBCullingPass | null = null; // Occlusion culling (layered on GPU)

  // Pass-level group 3 fallback for indirect draws that lack a per-key renderBindGroup.
  // TransparentRenderPass sets this to the water scene bind group before the transparent
  // pass and clears it afterward (null) to prevent leaking into other passes.
  private passGroup3: GPUBindGroup | null = null;

  public addKey(owner: RenderComponent, mesh: Mesh, material: Material, transform: TransformComponent): void {
    this.keyManager.addKey(owner, mesh, material, transform);
    if (material.getCastsShadows()) {
      this.keyManager.addKey(owner, mesh, material.getShadowsMaterial(), transform);
    }
  }
}
```

#### 2. **Culling System (GPU primary, CPU fallback)**

`RenderManagerV2` initialises three culling layers that work together:

| Layer | Class | Used for |
|---|---|---|
| **GPU frustum** (primary) | `GPUCullingManager` | Main camera — compute dispatch, zero CPU overhead |
| **HZB occlusion** (layered) | `HZBCullingPass` | Second pass over GPU-visible set, reads previous-frame HZB pyramid |
| **CPU frustum** (fallback) | `CPUCullingManager` | Shadow cameras; fallback if GPU culling unavailable |

```typescript
public async initialize(): Promise<void> {
  this.cpuCuller = new CPUCullingManager();       // always available
  this.gpuCuller = new GPUCullingManager();
  await this.gpuCuller.initialize();              // compute pipelines
  this.hzbCullingPass = new HZBCullingPass();
  await this.hzbCullingPass.initialize();
}

public performCulling(camera: Camera): void {
  // 1. GPU frustum cull all keys → indirect draw buffer
  this.gpuCuller.dispatch(this.keyManager.getAllKeys(), camera);

  // 2. HZB occlusion cull the surviving set (using last frame's depth pyramid)
  this.hzbCullingPass.dispatch(this.gpuCuller.getVisibleBuffer(), camera);
}
```

#### 3. **passGroup3 Mechanism**

`passGroup3` solves a bind-group slot collision between water draws and particle/trail draws:

- Water materials declare `WATER_SCENE` at `group(3)` (linear depth + env cubemap).
- Trails and particles bind a **dummy** empty bind group at `group(3)` to match their pipeline layout.
- Without correction the stale trail dummy bind group would remain bound when water draw calls run, causing a pipeline layout mismatch.
- `TransparentRenderPass.execute()` calls `RenderManagerV2.setPassGroup3(waterBindGroup)` **before** the transparent render, then `setPassGroup3(null)` **after**.
- Inside `renderKeys()`, every indirect draw that does not carry its own `renderBindGroup` re-binds `passGroup3` (if non-null) right before the draw.

#### 4. **State Management and Optimization**

The render manager implements sophisticated state management to minimise GPU state changes:

```typescript
private renderKeys(keys: RenderKey[], pass: GPURenderPassEncoder): number {
  let drawCalls = 0;

  // Set camera bind group once
  this.stateManager.setBindGroup(pass, 0, this.camera!.getBindGroup());

  for (const key of keys) {
    const technique = key.material.getTechnique()!;
    const pipeline = technique.getPipeline()!;

    // Use state manager to minimize state changes
    this.stateManager.setPipeline(pass, pipeline, () => technique.activatePipeline(pass));
    this.stateManager.setMeshBuffers(pass, key.mesh.getName(), () => key.mesh.activate(pass));
    this.stateManager.setBindGroup(pass, 1, key.transform.getModelBindGroup());
    this.stateManager.setMaterialBindings(
      pass,
      key.material.getName(),
      key.material.getTextureBindGroup(),
      2,
    );

    // Execute draw call
    key.mesh.renderGroup(pass);
    drawCalls++;
  }

  return drawCalls;
}
```

#### 5. **Category-Based Rendering**

The system supports multiple render categories with specialized handling:

```typescript
public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
  // Reset render state for this pass
  this.stateManager.reset();

  // Filter culled keys by category
  let keys = this.culledKeys;
  if (category === RenderCategory.SHADOWS) {
    keys = this.getAllKeys(); // Shadows bypass culling
  }
  const keysToDraw = keys.filter((key) => key.material.getCategory() === category);

  // Sort keys for optimal rendering
  this.keyManager.sortKeys(keysToDraw, category, this.camera);

  // Render the keys
  const drawCalls = this.renderKeys(keysToDraw, pass);
  this.drawCallsPerCategory.set(category, drawCalls);
}
```

### Performance Optimizations

#### 2. **Temporal Cache Management**

Intelligent caching system with motion-based validation:

```typescript
private isCacheEntryValid(entry: CullingCacheEntry): boolean {
  const currentCamera = this.getCurrentCameraState();
  const ageDelta = Date.now() - entry.timestamp;

  // Age-based invalidation
  if (ageDelta > 200) return false;

  // Motion-based invalidation with dynamic thresholds
  const positionDelta = vec3.distance(currentCamera.position, entry.cameraPosition);
  const directionDelta = vec3.dot(currentCamera.direction, entry.cameraDirection);
  const velocityMagnitude = this.stats.averageVelocity;
  const dynamicPositionThreshold = Math.max(8.0, velocityMagnitude * 2.0);

  return positionDelta < dynamicPositionThreshold && directionDelta > 0.85;
}
```

### Integration with Engine Systems

#### 1. **ECS Integration**

Direct integration with the Entity-Component-System:

```typescript
// Components provide render data
export class RenderComponent extends Component {
  public onAttach(): void {
    const renderManager = RenderManagerV2.getInstance();
    renderManager.addKey(this, this.mesh, this.material, this.transform);
  }

  public onDetach(): void {
    const renderManager = RenderManagerV2.getInstance();
    renderManager.delKeys(this);
  }
}
```

#### 2. **Quality Settings Integration**

Adapts culling parameters based on quality settings:

```typescript
public initialize(): Promise<void> {
  const qualitySettings = QualitySettings.getInstance();

  // CPU culling requires no special configuration
  // Quality settings can still control other rendering parameters
}
```

## Pipeline Integration

The three components work together in a coordinated fashion:

1. **ModuleRender** orchestrates the overall frame generation and post-processing chain
2. **DeferredRenderer** handles the core G-Buffer, lighting, transparent, OIT glass, SSR, and volumetrics passes
3. **RenderManagerV2** provides GPU-based frustum + HZB occlusion culling and indirect GPU draw dispatch

### Bloom System Integration

The compute-based bloom system integrates seamlessly with the rendering pipeline:

#### **Three-Phase Execution:**

1. **Downsample Phase**: Progressive resolution reduction using compute shaders

   - Separate command encoder submission for each mip level
   - Dynamic bind group creation for flexible mip chain handling
   - Proper synchronization to prevent GPU race conditions

2. **Upsample Phase**: Progressive resolution increase with bloom accumulation

   - Works directly with mip chain textures for efficiency
   - Uses linear filtering for smooth bloom gradients
   - Memory-efficient approach without additional accumulation textures

3. **Combine Phase**: Final composition of original and bloom results
   - High-performance compute shader for final blending
   - Quality-adaptive parameters based on engine settings
   - Seamless integration with tone mapping pipeline

#### **Synchronization Architecture:**

```typescript
// Each compute pass uses separate command encoder for guaranteed ordering
const downsampleEncoder = device.createCommandEncoder({ label: 'Bloom Downsample' });
const downsamplePass = downsampleEncoder.beginComputePass();
// ... downsample operations ...
downsamplePass.end();
device.queue.submit([downsampleEncoder.finish()]);

// Separate submission ensures proper synchronization
const upsampleEncoder = device.createCommandEncoder({ label: 'Bloom Upsample' });
// ... upsample operations ...
```

This architecture provides:

- **High Performance**: GPU-based frustum + HZB occlusion culling with zero CPU readback overhead
- **Visual Quality**: Physically-based deferred rendering with PBR specular IBL, OIT glass, water, SSR, and compute-based bloom
- **Correctness**: passGroup3 mechanism prevents bind group slot collisions across transparent, water, and particle passes
- **Maintainability**: Clear separation of concerns and responsibilities

The system is designed to handle complex 3D scenes efficiently while maintaining high visual fidelity and providing the flexibility needed for modern real-time rendering applications.

---

## Directional Light Shadow System

The WebGPU Engine implements a robust directional light shadow mapping system that provides high-quality shadows with excellent performance characteristics. This system uses orthographic projection for directional lights and includes sophisticated coordinate transformation and filtering techniques.

### System Architecture

#### **DirectionalLight Class**

The `DirectionalLight` class manages the complete shadow mapping pipeline:

```typescript
export class DirectionalLight {
  private camera!: Camera; // Orthographic shadow camera
  private shadowDepthTexture!: GPUTexture; // 2048x2048 depth texture
  private shadowDepthView!: GPUTextureView; // Depth-only view
  private shadowSampler!: GPUSampler; // Comparison sampler
  private uniformBuffer!: GPUBuffer; // Light uniforms + shadow matrix
}
```

### Shadow Camera Configuration

#### **Critical Setup Requirements**

The shadow camera configuration requires precise parameter setup to avoid matrix calculation issues:

```typescript
// CRITICAL: Correct orthographic parameter setup
// setOrthoParams(centered, left, WIDTH, top, HEIGHT)
this.camera.setOrthoParams(true, 0, 20, 0, 20); // Creates [-10,10] x [-10,10] bounds

// CRITICAL: Use non-degenerate up vector when looking straight down
this.camera.lookAt([0.0, 25.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);

// CRITICAL: Update matrices AFTER all parameter configuration
this.camera.updateUniforms();
```

#### **Common Configuration Pitfalls**

**❌ Incorrect orthographic bounds:**

```typescript
// WRONG: This creates bounds [-10, 0] x [-20, -10] instead of [-10, 10] x [-10, 10]
this.camera.setOrthoParams(true, -10, 10, -10, 10);
```

**❌ Degenerate up vector:**

```typescript
// WRONG: Creates degenerate View matrix when looking straight down
this.camera.lookAt([0, 25, 0], [0, 0, 0], [0, 1, 0]); // up parallel to front
```

**❌ Missing matrix update:**

```typescript
// WRONG: ViewProjection matrix remains uninitialized
this.camera.lookAt(...);
// Missing: this.camera.updateUniforms();
```

### Shadow Matrix Transformations

#### **Coordinate Space Pipeline**

The shadow system transforms coordinates through multiple spaces:

```
World Space → Light View Space → Light Clip Space → Light UV Space → Shadow Map
```

#### **UV Transform Matrix**

Critical Y-axis inversion fix for proper shadow coordinate mapping:

```typescript
// CRITICAL: Y-axis must be negative to fix shadow inversion
mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]); // Note: -0.5 for Y
mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);

// Correct transformation order: Translation * Scale
mat4.multiply(mtx_offset, mtx_translation, mtx_scale);

// Final matrix: UV_Transform * ViewProjection
mat4.multiply(lightViewProjOffset, mtx_offset, this.camera.getViewProjection());
```

#### **Light Direction Calculation**

```typescript
// CRITICAL: Light direction must be TOWARDS the light source
const cameraDirection = this.camera.getFront(); // [0, -1, 0] looking down
const lightDirection = vec3.fromValues(
  -cameraDirection[0], // Invert camera direction
  -cameraDirection[1], // Results in [0, 1, 0] - light from above
  -cameraDirection[2],
);
```

### GPU Resources and Sampling

#### **Shadow Texture Configuration**

```typescript
// High-resolution depth texture for quality shadows
this.shadowDepthTexture = GPUUtils.createTexture(
  'directional_light_shadow_depth_map',
  2048,
  2048, // High resolution for detailed shadows
  'depth32float',
  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
);

// Comparison sampler with proper clamping
this.shadowSampler = device.createSampler({
  magFilter: 'linear',
  minFilter: 'linear',
  addressModeU: 'clamp-to-edge', // Prevents texture wrapping artifacts
  addressModeV: 'clamp-to-edge',
  compare: 'less', // Depth comparison for shadow testing
});
```

### WGSL Shadow Sampling

#### **Enhanced Shadow Factor Calculation with Soft Shadows**

The shadow sampling has been enhanced with soft shadows, adaptive bias, and PCF filtering for modern shadow quality:

```wgsl
fn getShadowFactor(wPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>,
                   lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32,
                   shadowMap: texture_depth_2d, shadowSampler: sampler_comparison,
                   adaptUVs: bool) -> f32 {

    // Transform world position to light clip space
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;

    if(adaptUVs){
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }

    // Early rejection for out-of-bounds coordinates
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 0.0; // Outside shadow map = no shadow
    }

    // Enhanced filter radius for softer shadows
    let filterRadius = lightShadowStepDivResolution * 1.2;

    // Random rotation per pixel to break regular patterns
    let random = hash3(wPos) * 6.28318530718; // 2*PI
    let cosR = cos(random);
    let sinR = sin(random);

    // Poisson disk pattern for better sample distribution
    let offsets = array<vec2<f32>, 16>(
        vec2<f32>(-0.8, -0.4), vec2<f32>(-0.6, -0.9),
        vec2<f32>(-0.3, -0.6), vec2<f32>(-0.1, -0.3),
        // ... 12 more optimized samples ...
    );

    var shadow = 0.0;
    for (var i = 0; i < 16; i++) {
        // Rotate offsets to eliminate aliasing patterns
        let rotatedOffset = vec2<f32>(
            offsets[i].x * cosR - offsets[i].y * sinR,
            offsets[i].x * sinR + offsets[i].y * cosR
        );
        let sampleCoord = lightUVSpacePos.xy + rotatedOffset * filterRadius;
        shadow += shadowsTap(sampleCoord, lightUVSpacePos.z, normal, lightDir, shadowMap, shadowSampler);
    }

    let shadowResult = shadow / 16.0;
    // Apply smoothstep for natural soft shadow transitions
    return smoothstep(0.1, 0.9, shadowResult);
}
```

#### **Adaptive Bias Shadow Tap Function**

The shadow tap function now includes adaptive bias based on surface angle to eliminate shadow acne:

```wgsl
fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32, normal: vec3<f32>, lightDir: vec3<f32>,
              shadowMap: texture_depth_2d, shadowSampler: sampler_comparison) -> f32 {

    // GPU-friendly coordinate clamping (avoids branching)
    let clamped_coord = clamp(homo_coord, vec2<f32>(0.0), vec2<f32>(1.0));

    // Adaptive bias based on surface angle to light
    let cosTheta = clamp(dot(normal, -lightDir), 0.001, 1.0);
    let tanTheta = sqrt(1.0 - cosTheta * cosTheta) / cosTheta;

    // Slope-scaled bias: more bias on surfaces angled away from light
    let slopeBias = clamp(tanTheta * 0.002, 0.0, 0.01);
    let baseBias = 0.0002;
    let totalBias = baseBias + slopeBias;

    let biased_depth = coord_z - totalBias;
    return textureSampleCompareLevel(shadowMap, shadowSampler, clamped_coord, biased_depth);
}
```

### Modern Shadow Quality Features

#### **Soft Shadows Implementation**

The current implementation provides high-quality soft shadows through:

- **16-sample PCF**: Poisson disk pattern for natural shadow edges
- **Per-pixel rotation**: Hash-based rotation eliminates regular aliasing patterns
- **Adaptive filter radius**: Larger filter kernel (1.2x) for softer transitions
- **Smoothstep filtering**: Natural shadow edge transitions instead of hard cutoffs

#### **Adaptive Bias System**

The adaptive bias system prevents shadow acne while maintaining shadow accuracy:

- **Surface angle detection**: Uses surface normal and light direction
- **Dynamic bias calculation**: More bias on grazing angles, less on perpendicular surfaces
- **Conservative base bias**: Minimum bias (0.0002) for flat surfaces
- **Slope-scaled bias**: Up to 0.01 bias for extremely angled surfaces

### Performance Optimization Strategies

#### **Rendering Pipeline Integration**

```typescript
public renderShadowMap(): void {
  // 1. Configure shadow camera as active camera
  RenderManager.getInstance().setCamera(this.camera);

  // 2. Render only shadow-casting objects
  RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);
}

public render(rtAccLight: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
  // 3. Apply shadows during lighting pass with normal and light direction
  pass.setBindGroup(2, this.directionalLightBindGroup);  // Shadow resources
}
```

#### **Performance vs Quality Trade-offs**

**Current Implementation (High Quality Soft Shadows):**

- ✅ **16-sample PCF**: Multiple depth comparisons for soft edges
- ✅ **Adaptive bias**: Eliminates shadow acne without over-biasing
- ✅ **Per-pixel rotation**: Breaks aliasing patterns for natural appearance
- ✅ **Smoothstep filtering**: Natural shadow transitions
- ⚠️ **Higher GPU cost**: 16x more texture samples than single-sample approach

**Alternative High-Quality Options (Future Enhancements):**

- ✅ **PCF (Percentage-Closer Filtering)**: **IMPLEMENTED** - 16 samples with Poisson disk
- ⏳ **PCSS (Percentage-Closer Soft Shadows)**: Variable filter size based on blocker distance
- ⏳ **CSM (Cascaded Shadow Maps)**: Multiple resolution levels for large scenes
- ⏳ **VSM (Variance Shadow Maps)**: Soft shadows with pre-filtering
- ⏳ **ESM (Exponential Shadow Maps)**: Reduced aliasing and memory efficient

**Shadow Quality Achievements:**

- ✅ **Soft Shadow Edges**: Implemented via 16-sample PCF with Poisson disk
- ✅ **Eliminates Shadow Acne**: Adaptive bias based on surface angle
- ✅ **Reduces Aliasing**: Per-pixel rotation breaks regular patterns
- ✅ **Natural Transitions**: Smoothstep filtering for organic shadow falloff

### Debugging and Troubleshooting

#### **Common Shadow Issues and Solutions**

**Problem: Shadows completely missing**

```typescript
// Solution: Verify ViewProjection matrix is properly calculated
console.log('ViewProjection matrix:', camera.getViewProjection());
// Should show non-zero values, not mostly zeros
```

**Problem: Shadows inverted (appearing on wrong side)**

```typescript
// Solution: Ensure Y-scale is negative and light direction is inverted
mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]); // -0.5 for Y
const lightDirection = vec3.negate(vec3.create(), cameraDirection);
```

**Problem: Repeating patterns/artifacts**

```typescript
// Solution: Use clamp-to-edge addressing and avoid complex filtering
addressModeU: 'clamp-to-edge',
addressModeV: 'clamp-to-edge',
```

**Problem: Shadow acne (self-shadowing artifacts)**

```wgsl
// Solution: Apply appropriate depth bias
let biased_depth = coord_z - 0.0005;  // Adjust bias as needed
```

#### **Matrix Debugging Techniques**

```typescript
// Debug orthographic projection setup
console.log('Ortho params:', {
  isOrtho: camera.isOrthographic(),
  width: camera.getOrthoWidth(),
  height: camera.getOrthoHeight(),
  near: camera.getNear(),
  far: camera.getFar(),
});

// Debug matrix components
const proj = camera.getProjection();
const view = camera.getView();
const viewProj = camera.getViewProjection();

console.log('Projection diagonal:', [proj[0], proj[5], proj[10], proj[15]]);
console.log('View translation:', [view[12], view[13], view[14]]);
```

### Best Practices

#### **Shadow Quality Guidelines**

1. **Resolution**: Use 2048x2048 for good quality/performance balance
2. **Camera Bounds**: Size orthographic bounds to tightly fit scene
3. **Depth Range**: Use appropriate near/far planes (0.1 to 100.0)
4. **Adaptive Bias**: Use surface normal and light direction for automatic bias calculation
5. **Soft Shadows**: Enable PCF filtering with Poisson disk sampling for natural edges

#### **Performance Guidelines**

1. **PCF Sample Count**: Use 16 samples for high quality, 4 samples for performance
2. **Early Rejection**: Test bounds before expensive operations
3. **Per-pixel Rotation**: Use hash function to eliminate aliasing patterns
4. **Minimize State Changes**: Cache bind groups and samplers
5. **Adaptive Filter Radius**: Scale filter radius based on distance for better quality

#### **Modern Shadow Implementation Guidelines**

1. **Adaptive Bias**: Always use surface angle-based bias to prevent shadow acne
2. **Soft Shadow Edges**: Implement PCF with rotated Poisson disk samples
3. **Quality Scaling**: Provide multiple sample count options based on performance requirements
4. **Smooth Transitions**: Use smoothstep() for natural shadow edge falloff

This shadow system provides an excellent foundation for directional lighting in real-time applications, balancing visual quality with rendering performance through careful optimization and proper coordinate space handling.

---

## Shadow System Improvements (2025)

The WebGPU Engine shadow system has been significantly enhanced to provide modern, high-quality soft shadows with adaptive bias correction. These improvements address the common issues of pixelated shadow edges and shadow acne.

### **Implemented Enhancements**

#### **1. Soft Shadows with PCF Filtering**

**Problem Solved**: Hard, pixelated shadow edges that looked unrealistic.

**Implementation**:

- **16-sample PCF**: Uses Poisson disk pattern for natural shadow distribution
- **Per-pixel rotation**: Hash-based rotation eliminates regular aliasing patterns
- **Enhanced filter radius**: 1.2x scaling for softer shadow transitions
- **Smoothstep filtering**: Natural edge transitions instead of hard cutoffs

**Technical Details**:

```wgsl
// Enhanced PCF with rotated Poisson samples
let random = hash3(wPos) * 6.28318530718; // Random rotation per pixel
let rotatedOffset = vec2<f32>(
    offsets[i].x * cosR - offsets[i].y * sinR,
    offsets[i].x * sinR + offsets[i].y * cosR
);
let shadowResult = shadow / 16.0;
return smoothstep(0.1, 0.9, shadowResult); // Soft transitions
```

#### **2. Adaptive Bias System**

**Problem Solved**: Static bias causing shadow acne on angled surfaces.

**Implementation**:

- **Surface angle detection**: Uses dot product between surface normal and light direction
- **Dynamic bias calculation**: Automatically adjusts bias based on surface slope
- **Conservative base bias**: Minimum bias (0.0002) for flat surfaces
- **Slope-scaled bias**: Up to 0.01 bias for grazing angle surfaces

**Technical Details**:

```wgsl
// Adaptive bias based on surface angle
let cosTheta = clamp(dot(normal, -lightDir), 0.001, 1.0);
let tanTheta = sqrt(1.0 - cosTheta * cosTheta) / cosTheta;
let slopeBias = clamp(tanTheta * 0.002, 0.0, 0.01);
let totalBias = baseBias + slopeBias;
```

#### **3. Enhanced Function Signatures**

**Updated Parameters**: Shadow functions now receive surface normal and light direction for adaptive bias calculation.

**Function Changes**:

```wgsl
// Old signature (static bias)
fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, ...);

// New signature (adaptive bias + soft shadows)
fn getShadowFactor(wPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>,
                   lightViewProjOffset: mat4x4<f32>, ...);
```

### **Quality Improvements Achieved**

1. **✅ Eliminated Hard Shadow Edges**: PCF filtering with Poisson disk creates natural, soft shadow boundaries
2. **✅ Reduced Shadow Acne**: Adaptive bias prevents self-shadowing artifacts on angled surfaces
3. **✅ Removed Aliasing Patterns**: Per-pixel rotation breaks regular sampling patterns
4. **✅ Natural Shadow Transitions**: Smoothstep filtering creates organic shadow falloff
5. **✅ Maintained Performance**: 16-sample PCF provides excellent quality-to-performance ratio

### **Performance Considerations**

- **Sample Count**: 16 samples per shadow test (vs 1 sample previously)
- **GPU Cost**: ~16x increase in texture samples, but still performant on modern hardware
- **Quality Scaling**: Can be reduced to 4-sample PCF for performance-critical scenarios
- **Memory Impact**: No additional memory usage, only computational overhead

### **Integration with Existing Systems**

The enhanced shadow system maintains full compatibility with:

- **Deferred Rendering Pipeline**: Works seamlessly with G-Buffer lighting
- **Multiple Light Types**: Directional lights fully implemented, point/spot lights compatible
- **Quality Settings**: Can be scaled based on performance requirements
- **Debug UI**: Shadow parameters remain adjustable through debug interface

This modernized shadow system brings the WebGPU Engine's shadow quality up to current industry standards while maintaining the engine's performance-focused architecture.

---

## SamplerLibrary System

The WebGPU Engine implements a comprehensive sampler library system that provides centralized management of GPU sampling resources, eliminating redundant sampler creation and optimizing performance across all rendering components.

### System Architecture

#### **Core Concept**

GPU samplers are expensive resources to create and configure. The SamplerLibrary creates all commonly used samplers once during engine initialization and provides static access throughout the application lifecycle.

```typescript
/**
 * Biblioteca de samplers precreados para optimizar performance.
 * Los samplers son recursos costosos de crear, por lo que los reutilizamos.
 */
export class SamplerLibrary {
  private static initialized = false;

  // Specialized samplers for post-processing
  private static _simpleSampler: GPUSampler; // FXAA, bilateral filtering
  private static _bloomSampler: GPUSampler; // Bloom post-processing
  private static _ambientOcclusionSampler: GPUSampler; // AO techniques

  // Basic addressing modes
  private static _linearClamp: GPUSampler; // Linear with clamp-to-edge
  private static _linearRepeat: GPUSampler; // Linear with repeat
  private static _nearestClamp: GPUSampler; // Nearest with clamp-to-edge

  // 3D rendering optimized samplers
  private static _diffuseSampler: GPUSampler; // Albedo textures
  private static _normalMapSampler: GPUSampler; // Normal maps
  private static _skyboxSampler: GPUSampler; // Cubemap sampling
  private static _shadowMapSampler: GPUSampler; // Shadow depth comparison

  // Anisotropic filtering levels
  private static _anisotropic2x: GPUSampler; // 2x anisotropic
  private static _anisotropic4x: GPUSampler; // 4x anisotropic
  private static _anisotropic8x: GPUSampler; // 8x anisotropic
  private static _anisotropic16x: GPUSampler; // 16x anisotropic
}
```

### Initialization and Lifecycle

#### **Engine Integration**

The SamplerLibrary is initialized early in the engine startup process and cleaned up during shutdown:

```typescript
// In Render.ts - Engine initialization
export class Render {
  public async initialize(canvas: HTMLCanvasElement): Promise<void> {
    // ... WebGPU setup ...

    // Initialize sampler library after device creation
    SamplerLibrary.initialize();
  }

  public destroy(): void {
    // Cleanup samplers during engine shutdown
    SamplerLibrary.destroy();
  }
}
```

#### **Initialization Process**

```typescript
public static initialize(): void {
  if (SamplerLibrary.initialized) {
    console.warn('SamplerLibrary already initialized');
    return;
  }

  console.log('SamplerLibrary: Creating reusable samplers...');

  // Post-processing samplers
  SamplerLibrary._simpleSampler = GPUUtils.createSampler({
    label: 'fxaa_sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    maxAnisotropy: 1,
  });

  SamplerLibrary._bloomSampler = GPUUtils.createSampler({
    label: 'bloom_sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    maxAnisotropy: 1,
  });

  // ... additional samplers ...

  SamplerLibrary.initialized = true;
  console.log('SamplerLibrary: All samplers created successfully');
}
```

### Sampler Categories

#### **1. Post-Processing Samplers**

**FXAA/Simple Sampler (`simpleSampler`):**

```typescript
// Linear filtering, clamp-to-edge, no mipmaps
// Used for: FXAA, bilateral filter, general screen-space post-process
const sampler = SamplerLibrary.simpleSampler;
```

**Bloom Sampler (`bloom`):**

```typescript
// Linear filtering, clamp-to-edge, mipmaps — for bloom downsample / upsample
const sampler = SamplerLibrary.bloom;
```

**Ambient Occlusion Sampler (`ambientOcclusionSampler`):**

```typescript
// Nearest + clamp — optimized for AO passes
const sampler = SamplerLibrary.ambientOcclusionSampler;
```

#### **2. 3D Rendering Samplers**

**Anisotropic Sampler (`anisotropic16x`):**

```typescript
// 16× anisotropic, linear, repeat — for surface albedo / normal maps
const sampler = SamplerLibrary.anisotropic16x;
```

**Environment Cubemap Sampler (`environmentCubemap`):**

```typescript
// Linear, clamp-to-edge — for IBL environment specular
const sampler = SamplerLibrary.environmentCubemap;
```

**Shadow Sampler (`shadows`):**

```typescript
// Depth comparison sampler — for PCF shadow map sampling
const sampler = SamplerLibrary.shadows;
```

**Skybox Sampler (`skybox`):**

```typescript
// For skybox / procedural sky cubemap sampling
const sampler = SamplerLibrary.skybox;
```

#### **3. Available Samplers (complete list)**

| Getter | Use case |
|---|---|
| `SamplerLibrary.simpleSampler` | Linear filter — FXAA, bilateral filter, general post-process |
| `SamplerLibrary.bloom` | Linear clamp — bloom downsample / upsample |
| `SamplerLibrary.ambientOcclusionSampler` | AO passes |
| `SamplerLibrary.shadows` | Depth comparison sampler for shadow maps |
| `SamplerLibrary.anisotropic16x` | 16× anisotropic — diffuse / normal surface textures |
| `SamplerLibrary.skybox` | Cubemap / skybox sampling |
| `SamplerLibrary.environmentCubemap` | IBL environment cubemap (specular) |
| `SamplerLibrary.nonFilteringSampler` | Nearest neighbour — G-buffer reads, depth buffer |
| `SamplerLibrary.froxelRaymarchSampler` | Froxel volumetric raymarch |
| `SamplerLibrary.nearestRepeat` | Nearest + repeat — noise/LUT textures |

> `SamplerLibrary.anisotropic16x` is the only anisotropic preset. Use it for all surface texture sampling. There are no `anisotropic8x` / `4x` / `2x` variants.

### Component Integration

#### **Before SamplerLibrary (Inefficient)**

```typescript
// Old approach - creating samplers in each component
export class AntialiasingComponent extends Component {
  private createBindGroup(): void {
    // ❌ Creates new sampler every time — expensive GPU allocation
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      // ... configuration ...
    });

    this.bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 1, resource: sampler }],
    });
  }
}
```

#### **After SamplerLibrary (Optimized)**

```typescript
// New approach - using pre-created samplers
export class AntialiasingComponent extends Component {
  private createBindGroup(): void {
    // ✅ Uses pre-created optimized sampler — zero allocation cost
    const sampler = SamplerLibrary.simpleSampler;

    this.bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 1, resource: sampler }],
    });
  }
}
```

### Performance Benefits

#### **Resource Optimization**

- **Memory Efficiency**: 15+ reusable samplers instead of hundreds of duplicates
- **Creation Cost**: One-time initialization instead of per-component creation
- **GPU Resource Management**: Reduces GPU memory fragmentation
- **Initialization Speed**: Faster component loading due to pre-created resources

#### **Quality Consistency**

- **Standardized Configurations**: Consistent filtering across all components
- **Optimized Settings**: Each sampler optimized for its specific use case
- **Quality Adaptation**: Automatic anisotropic filtering based on quality settings
- **Debug Consistency**: All samplers have descriptive labels for debugging

### Usage Patterns

#### **Post-Processing Components**

```typescript
// Bloom component using specialized bloom sampler
const bloomSampler = SamplerLibrary.bloom;

// FXAA using simple linear sampler
const fxaaSampler = SamplerLibrary.simpleSampler;

// Ambient occlusion using noise-optimized sampler
const aoSampler = SamplerLibrary.ambientOcclusionSampler;
```

#### **Material System Integration**

```typescript
// Materials use SamplerLibrary for all GPU samplers — never create samplers manually
export class Material extends GPUResource {
  private createTextureBindGroup(): void {
    const anisotropicSampler = SamplerLibrary.anisotropic16x; // For albedo / normal textures

    // Bind group creation with optimized samplers...
  }
}
```

#### **Quality Settings Integration**

```typescript
// Automatic anisotropic filtering based on quality
const qualitySettings = QualitySettings.getInstance();
const anisotropicLevel = qualitySettings.getSettings().anisotropicFiltering;
const sampler = SamplerLibrary.getAnisotropicByLevel(anisotropicLevel);
```

### Best Practices

#### **Sampler Selection Guidelines**

1. **Post-Processing**: Use `simpleSampler` for most effects, `bloom` for bloom-specific operations
2. **3D Textures**: Use specialized samplers (`diffuse`, `normalMap`) for material textures
3. **Shadows**: Always use `shadowMap` sampler for depth comparison
4. **Quality Adaptation**: Use `getAnisotropicByLevel()` for quality-adaptive sampling

#### **Performance Guidelines**

1. **Never Create Samplers**: Always use SamplerLibrary instead of manual creation
2. **Check Initialization**: Verify library is initialized before accessing samplers
3. **Consistent Usage**: Use the same sampler type for the same texture purpose
4. **Memory Management**: SamplerLibrary handles all cleanup automatically

The SamplerLibrary system provides significant performance improvements while maintaining code clarity and consistency across the entire rendering pipeline.
