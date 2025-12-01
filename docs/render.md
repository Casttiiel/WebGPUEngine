# Render Module Architecture

The WebGPU Engine's rendering system is built around a sophisticated modular architecture that delivers high-performance 3D graphics through WebGPU. The system consists of three primary components that work in concert to provide physically-based rendering with advanced post-processing effects and performance optimizations.

## System Overview

The render module implements a modern deferred rendering pipeline with the following key features:

- **Deferred Rendering**: G-Buffer based approach for efficient multi-light scenarios
- **Physically-Based Rendering (PBR)**: Metallic-roughness workflow with Image-Based Lighting
- **Modular Post-Processing**: Extensible effects pipeline including high-performance compute-based bloom, tone mapping, anti-aliasing, ambient occlusion, and Screen Space Reflections (SSR)
- **Performance Optimization**: CPU-based frustum culling for reliable object culling and SamplerLibrary for GPU resource optimization
- **Quality Management**: Adaptive rendering quality based on performance requirements with comprehensive quality presets
- **WebGPU Optimization**: Optimized for 2K@60fps performance with dynamic resolution scaling and efficient resource management

### SamplerLibrary - GPU Resource Optimization

The engine features a comprehensive sampler library system that eliminates redundant GPU resource creation:

- **Centralized Management**: Pre-created samplers for all common use cases
- **Performance Optimization**: Avoids expensive GPU sampler creation during runtime
- **15+ Specialized Samplers**: Optimized configurations for FXAA, bloom, tone mapping, 3D rendering, anisotropic filtering
- **Quality Adaptive**: Anisotropic filtering levels (2x, 4x, 8x, 16x) based on quality settings
- **Memory Efficient**: Proper initialization and cleanup lifecycle

```typescript
// SamplerLibrary usage examples
SamplerLibrary.initialize(); // Called during engine startup
const fxaaSampler = SamplerLibrary.simpleSampler; // For FXAA antialiasing
const bloomSampler = SamplerLibrary.bloom; // For bloom post-processing
const diffuseSampler = SamplerLibrary.diffuse; // For albedo textures
const anisotropicSampler = SamplerLibrary.anisotropic8x; // High-quality filtering
```

### Quality Settings System

The engine includes comprehensive quality management with four preset levels:

- **LOW**: 75% resolution, no bloom/AO, MSAA 1x, optimized for lower-end hardware
- **MEDIUM**: 85% resolution, limited effects, MSAA 2x, balanced performance
- **HIGH**: 100% resolution, full effects, MSAA 4x, high-quality visuals
- **ULTRA**: 100% resolution, maximum effects, MSAA 4x, highest visual quality

### Note on Specular Reflections and Ambient Pass

**Specular IBL is not implemented in the ambient light shader pass.** Instead, specular reflections are handled in a later stage by the SSR (Screen Space Reflections) system. If a valid SSR reflection is found, it is composited as the physically-based specular. If no SSR hit is found, the fallback is to compute a generic specular value (not using the environment map). This means the ambient pass only provides diffuse (irradiance) lighting, and all specular environment or reflection effects are deferred to the SSR/compositing stage. This approach matches the engine's current implementation and is important for understanding the separation of responsibilities in the PBR pipeline.

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

  // 1. Get main camera and setup
  const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
  const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
  const camera = cameraComponent.getCamera();

  // 2. Set up render manager with camera
  RenderManager.getInstance().setCamera(camera);

  // 3. Deferred rendering (G-Buffer + Lighting + SSR)
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

````

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
````

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
    // Pre-render GPU culling
    RenderManager.getInstance().performPreRenderCulling();

    // Execute G-Buffer pass
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // Execute Decal pass
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // Ambient occlusion with optimized texture usage
    this.renderAO(camera, this.rtAO);

    // Lighting accumulation
    this.renderAccLight();

    // Screen Space Reflections
    this.renderSSR(camera);

    // Transparent objects
    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    // Final composition with SSR
    return this.composeSSR();
  }
}
```

#### 3. **Resource Management**

The deferred renderer manages multiple render targets and GPU resources:

```typescript
private rtAccLight!: RenderTarget;        // Accumulated lighting
private rtFinalComposite!: RenderTarget;  // Final composite with SSR
private rtAO!: RenderTarget;              // Ambient occlusion
private rtAOBinding!: RenderTarget;       // AO binding copy
private rtCopyAlbedos!: RenderTarget;     // G-Buffer copies for decals
private rtCopyNormals!: RenderTarget;
private rtCopySelfIllum!: RenderTarget;
private ssr!: ScreenSpaceReflections;     // SSR system
```

#### 4. **Screen Space Reflections Integration**

The renderer includes a complete SSR pipeline:

```typescript
private renderSSR(camera: Entity): void {
  if (!this.ssr || !this.ssr.isEnabled()) return;

  // Execute SSR pass with G-Buffer and lighting data
  this.ssr.executeSSRPass(this.gBufferBindGroup, this.rtAccLight.getView());
}

private composeSSR(): GPUTextureView {
  if (!this.ssr || !this.ssr.isEnabled()) {
    return this.rtAccLight.getView();
  }

  // Compose SSR with lighting
  this.ssr.composeSSR(
    this.rtAccLight.getView(),    // Lighting result
    this.rtFinalComposite.getView() // Final output
  );

  return this.rtFinalComposite.getView();
}
```

#### 5. **Lighting System Integration**

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

`RenderManagerV2` serves as the bridge between the ECS system and the GPU, managing render keys, performing culling operations, and coordinating draw calls. This component implements CPU-based frustum culling for reliable and efficient object culling.

### Core Architecture

#### 1. **Render Key Management**

The system organizes renderable objects through a render key system:

```typescript
export class RenderManagerV2 {
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private cpuCuller: CPUCullingManager | null = null;

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

#### 2. **CPU Frustum Culling System**

RenderManagerV2 implements a reliable CPU-based frustum culling system:

**CPU Frustum Culling:**

```typescript
// Initialize CPU culling system
this.cpuCuller = new CPUCullingManager();

public performPreRenderCulling(): void {
  if (!this.camera) return;

  const allKeys = this.keyManager.getAllKeys();

  // Direct CPU frustum culling - reliable and immediate
  this.culledKeys = this.cpuCuller!.performCulling(allKeys, this.camera);
}
```

#### 3. **CPU Culling Implementation**

The CPU culling system provides reliable frustum testing:

**Key Features:**

- **World Space Transformation**: Properly transforms object AABBs to world space using model matrices
- **Robust Algorithm**: Uses center + half-extents method (same as GPU shader implementation)
- **Immediate Results**: No frame lag - culling results available immediately
- **Debug Statistics**: Performance monitoring and culling efficiency tracking

**Culling Algorithm:**

````typescript
// Quadratic motion prediction: position = p0 + v*t + 0.5*a*t^2
private predictCameraPosition(currentCamera: Camera, frameDelta: number): Camera {
  // Calculate velocity from recent camera history
  const velocity = this.calculateVelocity();
  const acceleration = this.calculateAcceleration();

```typescript
// Transform AABB to world space using model matrix
const worldAABB = this.transformAABBToWorldSpace(key.aabb, modelMatrix);

// Calculate AABB center and half extents (matches GPU shader algorithm)
const aabbCenter = vec3.create();
const aabbHalf = vec3.create();

vec3.add(aabbCenter, worldAABB.min, worldAABB.max);
vec3.scale(aabbCenter, aabbCenter, 0.5);

vec3.subtract(aabbHalf, worldAABB.max, worldAABB.min);
vec3.scale(aabbHalf, aabbHalf, 0.5);

// Test against frustum planes using center + half-extents method
for (const plane of frustumPlanes) {
  const r = dot(abs(plane.normal), aabbHalf);
  const c = dot(plane.normal, aabbCenter) + plane.distance;

  if (c < -r) {
    return false; // Object is outside frustum
  }
}
````

**AABB Transformation:**

```typescript
private transformAABBToWorldSpace(aabb: AABB, modelMatrix: mat4): AABB {
  // Transform all 8 corners to world space
  for (let i = 0; i < 8; i++) {
    const corner = vec3.fromValues(
      (i & 1) !== 0 ? aabb.max[0] : aabb.min[0],
      (i & 2) !== 0 ? aabb.max[1] : aabb.min[1],
      (i & 4) !== 0 ? aabb.max[2] : aabb.min[2]
    );

    vec3.transformMat4(worldCorner, corner, modelMatrix);
    // Update world AABB bounds
  }
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

1. **ModuleRender** orchestrates the overall frame generation
2. **DeferredRenderer** handles the core G-Buffer and lighting passes
3. **RenderManagerV2** provides reliable CPU-based frustum culling and rendering

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

- **High Performance**: Efficient CPU-based culling with immediate results
- **Visual Quality**: Physically-based deferred rendering with advanced compute-based bloom
- **Reliability**: Direct frustum testing without frame lag or cache dependencies
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

**FXAA/Simple Sampler:**

```typescript
public static get simpleSampler(): GPUSampler {
  // Used for: FXAA antialiasing, bilateral filtering, simple post-processing
  // Configuration: Linear filtering, clamp-to-edge, no mipmaps
}
```

**Bloom Sampler:**

```typescript
public static get bloom(): GPUSampler {
  // Used for: Bloom downsampling, upsampling, and composition
  // Configuration: Linear filtering, clamp-to-edge, with mipmaps
}
```

**Ambient Occlusion Sampler:**

```typescript
public static get ambientOcclusionSampler(): GPUSampler {
  // Used for: SSAO noise textures, AO parameter sampling
  // Configuration: Nearest filtering, clamp-to-edge, optimized for noise
}
```

#### **2. 3D Rendering Samplers**

**Diffuse/Albedo Sampler:**

```typescript
public static get diffuse(): GPUSampler {
  // Used for: Albedo textures, diffuse maps
  // Configuration: Linear filtering, repeat addressing, 4x anisotropic
}
```

**Normal Map Sampler:**

```typescript
public static get normalMap(): GPUSampler {
  // Used for: Normal maps, bump maps
  // Configuration: Linear filtering, repeat addressing, 8x anisotropic
}
```

**Shadow Map Sampler:**

```typescript
public static get shadowMap(): GPUSampler {
  // Used for: Shadow depth comparison
  // Configuration: Linear filtering, clamp-to-edge, depth comparison enabled
}
```

#### **3. Quality-Adaptive Samplers**

**Anisotropic Filtering Levels:**

```typescript
public static getAnisotropicByLevel(level: number): GPUSampler {
  if (level >= 16) return SamplerLibrary.anisotropic16x;
  if (level >= 8) return SamplerLibrary.anisotropic8x;
  if (level >= 4) return SamplerLibrary.anisotropic4x;
  if (level >= 2) return SamplerLibrary.anisotropic2x;
  return SamplerLibrary.linearRepeat;
}
```

### Component Integration

#### **Before SamplerLibrary (Inefficient)**

```typescript
// Old approach - creating samplers in each component
export class AntialiasingComponent extends Component {
  private createBindGroup(): void {
    // ❌ Creates new sampler every time
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
    // ✅ Uses pre-created optimized sampler
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
// Materials automatically select appropriate samplers
export class Material extends GPUResource {
  private createTextureBindGroup(): void {
    const diffuseSampler = SamplerLibrary.diffuse; // For albedo
    const normalSampler = SamplerLibrary.normalMap; // For normals

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
