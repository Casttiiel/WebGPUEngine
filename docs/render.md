# Render Module Architecture

The WebGPU Engine's rendering system is built around a sophisticated modular architecture that delivers high-performance 3D graphics through WebGPU. The system consists of three primary components that work in concert to provide physically-based rendering with advanced post-processing effects and performance optimizations.

## System Overview

The render module implements a modern deferred rendering pipeline with the following key features:

- **Deferred Rendering**: G-Buffer based approach for efficient multi-light scenarios
- **Physically-Based Rendering (PBR)**: Metallic-roughness workflow with Image-Based Lighting
- **Modular Post-Processing**: Extensible effects pipeline including high-performance compute-based bloom, tone mapping, anti-aliasing, and ambient occlusion
- **Performance Optimization**: CPU-based frustum culling for reliable object culling
- **Quality Management**: Adaptive rendering quality based on performance requirements

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

**Bloom Integration:**
The system includes advanced compute-based bloom that adapts to quality settings through:

- **Adaptive Mip Count**: Quality settings control the number of downsampling steps (3-8 range)
- **Compute Shader Performance**: Uses WebGPU compute pipelines for maximum efficiency
- **Synchronization Architecture**: Separate command encoder submissions ensure proper execution order
- **Memory Management**: Dynamic bind group creation and efficient texture reuse

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

#### **Optimized Shadow Factor Calculation**

The shadow sampling in WGSL is optimized for performance while maintaining quality:

```wgsl
fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>,
                   lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d,
                   shadowSampler: sampler_comparison) -> f32 {

    // Transform world position to light clip space
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;

    // Early rejection for out-of-bounds coordinates
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0 ||
        lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 0.0; // Outside shadow map = no shadow
    }

    // Single sample for optimal performance
    return shadowsTap(lightUVSpacePos.xy, lightUVSpacePos.z, shadowMap, shadowSampler);
}
```

#### **Optimized Shadow Tap Function**

```wgsl
fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32, shadowMap: texture_depth_2d,
              shadowSampler: sampler_comparison) -> f32 {

    // GPU-friendly coordinate clamping (avoids branching)
    let clamped_coord = clamp(homo_coord, vec2<f32>(0.0), vec2<f32>(1.0));

    // Depth bias prevents shadow acne
    let biased_depth = coord_z - 0.0005;

    return textureSampleCompareLevel(shadowMap, shadowSampler, clamped_coord, biased_depth);
}
```

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
  // 3. Apply shadows during lighting pass
  pass.setBindGroup(2, this.directionalLightBindGroup);  // Shadow resources
}
```

#### **Performance vs Quality Trade-offs**

**Current Implementation (Optimized for Performance):**

- ✅ **Single sample**: One depth comparison per fragment
- ✅ **No PCF filtering**: Eliminates multiple texture lookups
- ✅ **Clamp instead of branch**: GPU-friendly coordinate handling
- ✅ **Early rejection**: Fast out-of-bounds testing

**Alternative High-Quality Options (Higher Cost):**

- **PCF (Percentage-Closer Filtering)**: 4-16 samples with Poisson disk
- **PCSS (Percentage-Closer Soft Shadows)**: Variable filter size
- **CSM (Cascaded Shadow Maps)**: Multiple resolution levels

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
4. **Bias Values**: Start with 0.0005 and adjust based on scene scale

#### **Performance Guidelines**

1. **Single Sample**: Use one sample per fragment for best performance
2. **Early Rejection**: Test bounds before expensive operations
3. **Clamp Coordinates**: Prefer clamp() over branching
4. **Minimize State Changes**: Cache bind groups and samplers

This shadow system provides an excellent foundation for directional lighting in real-time applications, balancing visual quality with rendering performance through careful optimization and proper coordinate space handling.
