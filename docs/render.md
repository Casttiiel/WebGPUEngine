# Render Module Architecture

The WebGPU Engine's rendering system is built around a sophisticated modular architecture that delivers high-performance 3D graphics through WebGPU. The system consists of three primary components that work in concert to provide physically-based rendering with advanced post-processing effects and performance optimizations.

## System Overview

The render module implements a modern deferred rendering pipeline with the following key features:

- **Deferred Rendering**: G-Buffer based approach for efficient multi-light scenarios
- **Physically-Based Rendering (PBR)**: Metallic-roughness workflow with Image-Based Lighting
- **Modular Post-Processing**: Extensible effects pipeline including bloom, tone mapping, anti-aliasing, and ambient occlusion
- **Performance Optimization**: GPU-based frustum culling with temporal culling system
- **Quality Management**: Adaptive rendering quality based on performance requirements

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
    await this.initializePresentationData();

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

  // 1. Get main camera and setup
  const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
  const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
  const camera = cameraComponent.getCamera();

  // 2. Set up render manager with camera
  RenderManager.getInstance().setCamera(camera);

  // 3. Deferred rendering (G-Buffer + Lighting)
  let result = this.deferred.render(mainCamera);

  // 4. Post-processing chain
  if (mainCamera?.hasComponent('bloom')) {
    const bloom = mainCamera.getComponent('bloom') as BloomComponent;
    result = bloom.apply(result);
  }

  // 5. Distortion effects
  this.renderDistorsions(result);

  // 6. Tone mapping (HDR → LDR)
  if (mainCamera?.hasComponent('tone_mapping')) {
    const toneMapping = mainCamera.getComponent('tone_mapping') as ToneMappingComponent;
    result = toneMapping.apply(result);
  }

  // 7. Anti-aliasing (FXAA)
  if (mainCamera?.hasComponent('antialiasing')) {
    const antialiasing = mainCamera.getComponent('antialiasing') as AntialiasingComponent;
    result = antialiasing.apply(result);
  }

  // 8. Final presentation
  this.presentResult(result);

  Render.getInstance().endFrame();
}
```

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
  @location(2) selfIllum: vec4<f32>;  // RGB: emissive, A: unused
  @location(3) depth: f32;            // Linear depth (0-1)
}
```

#### 2. **Render Pass System**

The deferred renderer uses a modular render pass system managed by `RenderPassManager`:

```typescript
export class DeferredRenderer {
  private renderPassManager!: RenderPassManager;
  private gBufferPass!: GBufferPass;

  public render(camera: Entity): GPUTextureView {
    // Pre-render GPU culling
    RenderManager.getInstance().performPreRenderCulling();

    // Execute G-Buffer pass
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // Execute Decal pass
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // Resolve MSAA depth if needed
    if (msaaLevel > 1) {
      this.depthResolver.resolve(gBufferDepthTextures.msaaDepth, gBufferDepthTextures.singleDepth);
    }

    // Ambient occlusion
    this.renderAO(camera, this.rtAO);

    // Lighting accumulation
    this.renderAccLight();

    // Transparent objects
    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    return this.rtAccLight.getView();
  }
}
```

#### 3. **Resource Management**

The deferred renderer manages multiple render targets and GPU resources:

```typescript
private rtAccLight!: RenderTarget;        // Accumulated lighting
private rtAO!: RenderTarget;              // Ambient occlusion
private rtAOBinding!: RenderTarget;       // AO binding copy
private rtCopyAlbedos!: RenderTarget;     // G-Buffer copies for decals
private rtCopyNormals!: RenderTarget;
private rtCopySelfIllum!: RenderTarget;
```

#### 4. **Lighting System Integration**

The renderer integrates multiple lighting systems:

```typescript
private renderAccLight(): void {
  // Ambient lighting with IBL
  this.ambientLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);

  // Directional lighting (sun/shadows)
  this.directionalLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);

  // Dynamic point and spot lights
  this.renderPassManager.executePass('pointLights');
  this.renderPassManager.executePass('spotLights');

  // Skybox rendering
  const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
  this.skybox.render(this.rtAccLight.getView(), gBufferDepthTextures.singleDepthView);
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

`RenderManagerV2` serves as the bridge between the ECS system and the GPU, managing render keys, performing culling operations, and coordinating draw calls. This component implements advanced performance optimizations including temporal culling and GPU-based frustum culling.

### Core Architecture

#### 1. **Render Key Management**

The system organizes renderable objects through a render key system:

```typescript
export class RenderManagerV2 {
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private frustumCuller: GPUFrustumCuller | null = null;
  private temporalCuller: TemporalCullingManager | null = null;

  public addKey(
    owner: RenderComponent,
    mesh: Mesh,
    material: Material,
    transform: TransformComponent,
  ): void {
    this.keyManager.addKey(owner, mesh, material, transform);

    // Add shadow casting variant if needed
    if (material.getCastsShadows()) {
      this.keyManager.addKey(owner, mesh, material.getShadowsMaterial(), transform);
    }
  }
}
```

#### 2. **Advanced Culling System**

RenderManagerV2 implements a sophisticated two-tier culling system:

**GPU Frustum Culling:**

```typescript
// Initialize GPU frustum culler
this.frustumCuller = new GPUFrustumCuller();
await this.frustumCuller.load();
```

**Temporal Culling with Motion Prediction:**

```typescript
// Initialize temporal culling system
this.temporalCuller = new TemporalCullingManager(this.frustumCuller);

public performPreRenderCulling(): void {
  if (!this.camera) return;

  const allKeys = this.keyManager.getAllKeys();

  // Temporal culling with motion prediction and cache
  this.culledKeys = this.temporalCuller!.performCulling(allKeys, this.camera);
}
```

#### 3. **Temporal Culling System**

The temporal culling system provides AAA-style lag compensation:

**Key Features:**

- **Motion Prediction**: Uses camera velocity and acceleration to predict future positions
- **Frame Lag Compensation**: Uses results from previous frames while computing future frames in background
- **Cache Management**: Intelligent caching system with motion-based invalidation
- **Fallback Strategies**: Multiple fallback approaches when cache misses occur

**Motion Prediction Algorithm:**

```typescript
// Quadratic motion prediction: position = p0 + v*t + 0.5*a*t^2
private predictCameraPosition(currentCamera: Camera, frameDelta: number): Camera {
  // Calculate velocity from recent camera history
  const velocity = this.calculateVelocity();
  const acceleration = this.calculateAcceleration();

  // Predict future position with motion physics
  const predictedTime = frameDelta * frameTime;
  const linearOffset = velocity * predictedTime * predictionStrength;
  const quadraticOffset = 0.5 * acceleration * predictedTime^2 * predictionStrength;

  const predictedPosition = currentPosition + linearOffset + quadraticOffset;

  return this.createPredictedCamera(predictedPosition);
}
```

**Cache System:**

```typescript
public performCulling(keys: RenderKey[], camera: Camera): RenderKey[] {
  this.frameNumber++;
  this.updateCameraHistory(camera);

  // Get cached results immediately (0ms blocking)
  const cachedResults = this.getCachedResults(keys);

  // Start background culling for future frame
  this.startBackgroundCulling(keys, camera);

  return cachedResults;
}
```

#### 4. **State Management and Optimization**

The render manager implements sophisticated state management to minimize GPU state changes:

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

#### 1. **GPU-Based Frustum Culling**

Uses compute shaders for parallel frustum testing:

```typescript
export class GPUFrustumCuller {
  private computeShader: string = /* WGSL compute shader */;

  public async cullObjects(camera: Camera, objects: CullableObject[]): Promise<CullResult> {
    // Upload object data to GPU buffers
    // Execute compute shader for parallel frustum testing
    // Read back visibility results
    return { visibleIndices, culledCount };
  }
}
```

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
  const cullingConfig = qualitySettings.getCullingConfig();

  this.temporalCuller.setFrameLag(cullingConfig.frameLag);
  this.temporalCuller.setPredictionStrength(cullingConfig.predictionStrength);
}
```

## Pipeline Integration

The three components work together in a coordinated fashion:

1. **ModuleRender** orchestrates the overall frame generation
2. **DeferredRenderer** handles the core G-Buffer and lighting passes
3. **RenderManagerV2** provides optimized object culling and rendering

This architecture provides:

- **High Performance**: GPU-based culling with temporal optimization
- **Visual Quality**: Physically-based deferred rendering with post-processing
- **Scalability**: Modular design allows for easy extension and modification
- **Maintainability**: Clear separation of concerns and responsibilities

The system is designed to handle complex 3D scenes efficiently while maintaining high visual fidelity and providing the flexibility needed for modern real-time rendering applications.
