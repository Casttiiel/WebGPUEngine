# WebGPU Engine Development Guide

## Purpose and Scope

The WebGPU Engine is a modern 3D rendering engine built on WebGPU technology, implementing physically-based rendering (PBR) with deferred shading, Entity-Component-System (ECS) architecture, and modular render pass system for real-time graphics applications.

The engine leverages WebGPU's capabilities to deliver high-performance 3D rendering in web browsers, supporting advanced lighting models, post-processing effects, and efficient resource management for interactive 3D applications.

## IMPORTANT: Update Instructions

**Every time you make changes to the engine, you MUST update this Copilot Instructions file to reflect:**

- New file structures or patterns
- Updated code examples and paths
- Modified architectural decisions
- New development patterns
- Changed best practices

This ensures future AI assistance remains accurate and helpful.

## System Architecture

### High-Level Architecture Layers

```
Application Layer     │ index.html, main.ts, src/style.css
Core Module System    │ Engine, ModuleManager, ModuleBoot, ModuleInput, ModuleEntities, ModuleRender
Scene Layer          │ Entity, Component, TransformComponent, RenderComponent, CameraComponent
Resource Layer       │ ResourceManager, Technique, Material, Mesh, Texture, Cubemap
WebGPU Layer         │ WebGPU Device & Context, RenderManager, DeferredRenderer
```

### Module System Architecture

The engine implements a module-based architecture with clear separation of concerns:

#### Core Modules (src/modules/)

**ModuleManager** (`src/modules/core/ModuleManager.ts`)

- Coordinates all engine modules
- Manages module lifecycle (init → start → update → render → destroy)
- Centralized module registration and dependency management

**ModuleBoot** (`src/modules/game/ModuleBoot.ts`)

- Engine initialization and startup procedures
- WebGPU device creation and context setup
- Initial resource loading and configuration

**ModuleInput** (`src/modules/game/ModuleInput.ts`)

- User input processing (keyboard, mouse, touch)
- Input event handling and state management
- Integration with camera and interaction systems

**ModuleEntities** (`src/modules/game/ModuleEntities.ts`)

- ECS (Entity-Component-System) management
- Entity creation, destruction, and hierarchy
- Component registration and lifecycle management
- Scene graph traversal and updates

**ModuleRender** (`src/modules/game/ModuleRender.ts`)

- Graphics pipeline coordination
- Deferred rendering implementation
- Draw call management and optimization
- Post-processing effects coordination

**ModuleCameraMixer** (`src/modules/game/ModuleCameraMixer.ts`)

- Camera system management
- Multiple camera support and switching
- Camera animation and interpolation

### Module Lifecycle

```typescript
// Reference: src/modules/core/Module.ts
interface Module {
  init(): Promise<void>; // Initialize module resources
  start(): void; // Start module operation
  update(dt: number): void; // Per-frame updates
  render(): void; // Rendering operations
  destroy(): void; // Cleanup resources
}
```

## Entity Component System (ECS)

### Core ECS Concepts (src/core/ecs/)

**Entities** (`src/core/ecs/Entity.ts`)

- Unique containers identified by IDs
- Support hierarchical parent-child relationships
- Serve as attachment points for components
- No inherent functionality - purely organizational

**Components** (`src/core/ecs/Component.ts`)

- Modular pieces of functionality and data
- Single responsibility principle
- Attach to entities to provide specific behaviors
- Can be combined for complex entity behaviors

### Component Types (src/components/)

#### Core Components (`src/components/core/`)

**TransformComponent** (`src/components/core/TransformComponent.ts`)

```typescript
class TransformComponent implements Component {
  transform: Transform; // Local transformation data
  uniformBuffer: GPUBuffer; // GPU buffer for model matrix
  modelBindGroup: GPUBindGroup; // WebGPU bind group (group 1)

  // Automatic GPU uniform updates
  updateModelMatrix(): void;
  getWorldMatrix(): mat4;
}
```

Features:

- Hierarchical transformations with automatic propagation
- Direct GPU uniform buffer integration
- World space matrix calculation
- WebGPU bind group management for shaders

**NameComponent** (`src/components/core/NameComponent.ts`)

- Simple component for entity identification and debugging

#### Render Components (`src/components/render/`)

**CameraComponent** (`src/components/render/CameraComponent.ts`)

```typescript
class CameraComponent implements Component {
  projectionMatrix: mat4; // Projection transformation
  viewMatrix: mat4; // View transformation
  screenToWorld: mat4; // For position reconstruction in deferred rendering
  viewProjection: mat4; // Combined matrix

  // Camera parameters
  fov: number;
  aspectRatio: number;
  zNear: number;
  zFar: number;
}
```

**RenderComponent** (`src/components/render/RenderComponent.ts`)

- Mesh rendering capabilities
- Material assignments
- Render category management

**Lighting Components:**

- **PointLightComponent** (`src/components/render/PointLightComponent.ts`)
- **SpotLightComponent** (`src/components/render/SpotLightComponent.ts`)

**Post-Processing Components:**

- **ToneMappingComponent** (`src/components/render/ToneMappingComponent.ts`)
- **AntialiasingComponent** (`src/components/render/AntialiasingComponent.ts`)
- **AmbientOcclusionComponent** (`src/components/render/AmbientOcclusionComponent.ts`)

## Modular Render Pass System

### Architecture Overview (`src/renderer/core/passes/`)

The engine implements a fully modular render pass system that eliminates manual `beginRenderPass` logic:

**BaseRenderPass** (`src/renderer/core/passes/BaseRenderPass.ts`)

- Abstract base class for all render passes
- Handles common pass execution logic
- Viewport and scissor configuration
- Pass descriptor management

**RenderPassManager** (`src/renderer/core/passes/RenderPassManager.ts`)

- Centralizes render pass coordination
- Manages registered passes by name
- Supports dynamic pass execution
- Provides specialized methods for common pass types

**RenderPassFactory** (`src/renderer/core/passes/RenderPassFactory.ts`)

- Factory for creating render pass configurations
- Centralized blend state creation
- Pass-specific configuration builders

### Render Pass Types

#### Deferred Rendering Passes (`src/renderer/core/passes/DeferredRenderPasses.ts`)

```typescript
// G-Buffer Pass
export class GBufferRenderPass extends BaseRenderPass {
  // Geometry rendering to multiple render targets
}

// Decal Pass
export class DecalRenderPass extends BaseRenderPass {
  // Decal projection and blending
}

// Transparent Pass
export class TransparentRenderPass extends BaseRenderPass {
  // Forward rendering for transparent objects
}
```

#### Lighting Passes (`src/renderer/core/passes/LightingRenderPasses.ts`)

```typescript
// Point Light Pass
export class PointLightRenderPass extends BaseRenderPass {
  // Point light deferred shading
}

// Spot Light Pass
export class SpotLightRenderPass extends BaseRenderPass {
  // Spot light deferred shading with frustum
}
```

#### Post-Processing Passes (`src/renderer/core/passes/PostProcessingRenderPasses.ts`)

```typescript
// Base Post-Processing Pass
export abstract class PostProcessingRenderPass extends BaseRenderPass {
  // Common post-processing functionality
}

// Tone Mapping Pass
export class ToneMappingRenderPass extends PostProcessingRenderPass {
  // HDR to LDR tone mapping
}

// Anti-aliasing Pass
export class AntialiasingRenderPass extends PostProcessingRenderPass {
  // FXAA anti-aliasing
}

// Ambient Occlusion Pass
export class AmbientOcclusionRenderPass extends PostProcessingRenderPass {
  // Screen-space ambient occlusion
}
```

### Specialized Passes

**GBufferPass** (`src/renderer/core/passes/GBufferPass.ts`)

- Handles G-Buffer geometry rendering
- Integrates with ECS for entity processing
- Supports MSAA and viewport management

**DepthResolver** (`src/renderer/core/DepthResolver.ts`)

- Manual MSAA depth resolve for compatibility
- Uses specialized technique and mesh
- Integrates with the modular pass system

## Rendering Pipeline

### Deferred Rendering Architecture (`src/renderer/core/DeferredRenderer.ts`)

The engine implements a G-buffer based deferred rendering pipeline with full modular pass integration:

#### G-Buffer Layout

```wgsl
struct FragmentOutput {
  @location(0) albedo: vec4<f32>;     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>;     // RGB: world normal, A: roughness
  @location(2) selfIllum: vec4<f32>;  // RGB: emissive, A: unused
  @location(3) depth: f32;            // Linear depth (0-1)
}
```

#### Rendering Passes

**1. G-Buffer Pass**

- Geometry rendering to multiple render targets
- World space normal encoding
- Linear depth calculation for position reconstruction
- Material parameter storage (metallic, roughness, emissive)

**2. Lighting Pass**

- Screen-space lighting calculations
- World position reconstruction from linear depth
- Physically-Based Rendering (PBR) with Image-Based Lighting
- Multiple light type support (directional, point, spot)

**3. Post-Processing Pass**

- Anti-aliasing (FXAA)
- Tone mapping and color grading
- Ambient occlusion (SSAO)
- Distortion effects

### Physically-Based Rendering (PBR)

#### Material Model

- Metallic-roughness workflow
- Energy conservation principles
- Fresnel calculations for realistic reflections
- Image-Based Lighting (IBL) for ambient illumination

#### Shader Implementation

```wgsl
// PBR calculation in ambient.fs
fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
  let F0 = mix(vec3<f32>(0.04), g.albedo, g.metallic);
  let F = fresnelSchlickRoughness(NdotV, F0, g.roughness);
  let kS = F; let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic);
  // Combine diffuse and specular with energy conservation
}
```

### Position Reconstruction

Critical for deferred rendering - reconstructing world positions from screen coordinates:

```wgsl
fn getWorldCoords(coords: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
  let ndc_coords = (coords * 2.0) - 1.0;
  let near_ndc = vec4<f32>(ndc_coords.x, ndc_coords.y, -1.0, 1.0);
  let near_world_homogeneous = camera.screenToWorld * near_ndc;
  let near_world = near_world_homogeneous.xyz / near_world_homogeneous.w;
  let ray_direction = normalize(near_world - camera.cameraPosition);
  let distance_along_front = zlinear * camera.cameraZFar;
  let distance_along_ray = distance_along_front / dot(ray_direction, camera.cameraFront);
  return camera.cameraPosition + ray_direction * distance_along_ray;
}
```

## Resource Management

### Core Resource System (`src/core/resources/`)

**IResource** (`src/core/resources/IResource.ts`)

- Interface for all engine resources
- Standardized load/dispose lifecycle

**GPUResource** (`src/core/resources/GPUResource.ts`)

- Base class for WebGPU resources
- GPU memory management

**ResourceManager** (`src/core/engine/ResourceManager.ts`)

- Centralized resource loading and caching
- Asynchronous resource resolution

### Asset Loading System (`src/renderer/resources/`)

**Supported Formats**

- GLTF: 3D models with PBR materials
- PNG/JPG: Texture maps
- JSON: Scene definitions and prefabs
- OBJ: Simple mesh format

**Resource Types**

```typescript
// Reference implementations:
// src/renderer/resources/Mesh.ts
class MeshResource {
  vertices: Float32Array;
  indices: Uint32Array;
}

// src/renderer/resources/Texture.ts
class TextureResource {
  texture: GPUTexture;
  sampler: GPUSampler;
}

// src/renderer/resources/Material.ts
class MaterialResource {
  technique: Technique;
  parameters: MaterialParams;
}

// src/renderer/resources/Cubemap.ts
class CubemapResource {
  faces: GPUTexture[];
}
```

### Technique System (`src/renderer/resources/Technique.ts`)

Declarative shader pipeline configuration:

```json
// Example technique definition (assets/techniques/*.tech)
{
  "vertex": "basic.vs",
  "fragment": "basic.fs",
  "blendMode": "OPAQUE",
  "depthMode": "LESS_EQUAL",
  "cullMode": "BACK"
}
```

### GPU Resource Management

**RenderTarget** (`src/renderer/core/RenderTarget.ts`)

- Render target management
- MSAA support with usage flag handling
- Automatic view creation

**Factories** (`src/renderer/core/factories/`)

- **BindGroupFactory** (`src/renderer/core/factories/BindGroupFactory.ts`) - Bind group creation and caching
- **PipelineFactory** (`src/renderer/core/factories/PipelineFactory.ts`) - Pipeline state and blend mode management

## Utilities and Tools

### GPU Utilities (`src/renderer/core/utils/GPUUtils.ts`)

Centralized WebGPU utility functions:

```typescript
class GPUUtils {
  // Viewport and scissor configuration
  static configureViewportAndScissor(
    pass: GPURenderPassEncoder,
    width?: number,
    height?: number,
  ): void;

  // Render pass descriptor creation
  static createRenderPassDescriptor(
    label: string,
    colorAttachments: GPURenderPassColorAttachment[],
    depthStencilAttachment?: GPURenderPassDepthStencilAttachment,
  ): GPURenderPassDescriptor;

  // Attachment creation helpers
  static createColorAttachment(
    view: GPUTextureView,
    loadOp: GPULoadOp,
    storeOp: GPUStoreOp,
    clearValue?: GPUColor,
  ): GPURenderPassColorAttachment;
  static createDepthStencilAttachment(
    view: GPUTextureView,
    depthLoadOp: GPULoadOp,
    depthStoreOp: GPUStoreOp,
    clearValue?: number,
  ): GPURenderPassDepthStencilAttachment;

  // Sampler creation
  static createSampler(descriptor: GPUSamplerDescriptor): GPUSampler;
}
```

### Render Management (`src/renderer/core/managers/`)

**RenderManagerV2** (`src/renderer/core/managers/RenderManagerV2.ts`)

- Entity rendering coordination
- Category-based render organization
- Integration with ECS system

**RenderKeyManager** (`src/renderer/core/managers/RenderKeyManager.ts`)

- Render key generation and management
- Sorting and batching optimization

**RenderStateManager** (`src/renderer/core/managers/RenderStateManager.ts`)

- GPU state management and optimization

### Specialized Systems

**ShaderPreprocessor** (`src/renderer/core/ShaderPreprocessor.ts`)

- WGSL shader processing and optimization

**MipmapGenerator** (`src/renderer/core/MipmapGenerator.ts`)

- GPU-based mipmap generation for textures

**GPUFrustumCuller** (`src/renderer/culling/GPUFrustumCuller.ts`)

- GPU-based frustum culling for performance

## Shader System

### WGSL Shader Architecture (`assets/shaders/`)

**Uniform Buffer Layout**

```wgsl
struct CameraUniforms {
  viewMatrix: mat4x4<f32>;
  projectionMatrix: mat4x4<f32>;
  screenToWorld: mat4x4<f32>;
  cameraPosition: vec3<f32>;
  screenSize: vec2<f32>;
  cameraFront: vec3<f32>;
  cameraZFar: f32;
}

struct ObjectUniforms {
  modelMatrix: mat4x4<f32>;
}
```

**Bind Group Layout** (`src/types/PipelineBindGroupLayouts.enum.ts`)

- Group 0: Camera uniforms (global)
- Group 1: Object uniforms (per-object)
- Group 2: Material textures and samplers
- Group 3: Lighting data

### Shader Organization

**Core Shaders:**

- `basic.vs/fs` - Basic mesh rendering
- `gbuffer.vs/fs` - G-Buffer generation
- `pbr.vs/fs` - Physically-based rendering

**Lighting Shaders:**

- `ambient.fs` - Ambient lighting and IBL
- Point/spot light shaders for deferred lighting

**Post-Processing Shaders:**

- `antialiasing.fs` - FXAA implementation
- `tone_mapping.fs` - HDR tone mapping
- `ambient_occlusion.fs` - SSAO implementation

**Utility Shaders:**

- `depth_resolve.fs` - MSAA depth resolve
- `skybox.vs/fs` - Skybox rendering
- `presentation.vs/fs` - Final presentation

**Common Functions:** (`assets/shaders/common/`)

- Shared utility functions and constants
- PBR calculation helpers

## MSAA (Multisample Anti-Aliasing) Implementation

### MSAA Architecture

The engine implements MSAA in the deferred rendering pipeline with manual depth resolve:

**MSAA Textures Creation**

- G-Buffer textures support both MSAA and single-sample formats
- Depth buffer has both MSAA (for geometry pass) and single-sample (for post-processing) versions
- Sample count is configurable (typically 4x MSAA)

**Manual Depth Resolve** (`src/renderer/core/DepthResolver.ts`)

- Custom depth resolve pass using a fullscreen quad and shader
- Resolves MSAA depth to single-sample for skybox and post-processing compatibility
- Uses the engine's Technique and Mesh systems for consistency

### DepthResolver Implementation

```typescript
export class DepthResolver {
  private depthResolveTechnique: Technique; // Uses depth_resolve.tech
  private fullscreenQuadMesh: Mesh; // fullscreenquad.obj

  resolve(msaaDepth: GPUTexture, singleDepth: GPUTexture): void;
}
```

**Key Features:**

- Integrates with existing resource management system
- Uses `depth_resolve.tech` technique with `DEPTH_ONLY` fragment target
- Employs `ALWAYS` depth mode for unconditional depth writing
- Samples all MSAA samples and selects minimum depth (closest surface)

### Extended Enums for MSAA Support

**Fragment Target:** (`src/types/FragmentShaderTargets.enum.ts`)

- `DEPTH_ONLY`: For depth-only rendering passes (depth resolve)

**Depth Mode:** (`src/types/DepthModes.enum.ts`)

- `ALWAYS`: Unconditional depth writing (depthCompare: 'always')

**Bind Group Layout:** (`src/types/PipelineBindGroupLayouts.enum.ts`)

- `DEPTH_TEXTURE`: For binding depth textures in shaders

## Type System (`src/types/`)

### Enums and Constants

**Rendering Enums:**

- `BlendModes.enum.ts` - Blend mode definitions
- `DepthModes.enum.ts` - Depth test configurations
- `FragmentShaderTargets.enum.ts` - Fragment output targets
- `RasterizationMode.enum.ts` - Rasterization settings
- `RenderCategory.enum.ts` - Object rendering categories

**Input Enums:**

- `KeyCode.enum.ts` - Keyboard input codes
- `MouseButton.enum.ts` - Mouse button definitions

**Resource Enums:**

- `ResourceType.enum.ts` - Resource type identifiers
- `PipelineBindGroupLayouts.enum.ts` - Bind group layout types

### Data Types

**Component Data Types:**

- `CameraComponentData.type.ts` - Camera configuration
- `RenderComponentData.type.ts` - Render settings
- `TransformComponentData.type.ts` - Transform data
- `AABBComponentData.type.ts` - Bounding box data

**Asset Data Types:**

- `MaterialData.type.ts` - Material definitions
- `MeshData.type.ts` - Mesh geometry data
- `TextureData.type.ts` - Texture configurations
- `CubemapData.type.ts` - Cubemap definitions
- `GLTF.type.ts` - GLTF asset structure

**Scene Data Types:**

- `SceneData.type.ts` - Scene composition
- `ComponentData.type.ts` - Generic component data

## Core Math System (`src/core/math/`)

**Transform** (`src/core/math/Transform.ts`)

- Position, rotation, scale management
- Matrix calculations and hierarchy support

**Camera** (`src/core/math/Camera.ts`)

- Camera projection and view calculations
- Frustum management

**AABB** (`src/core/math/AABB.ts`)

- Axis-aligned bounding box calculations
- Collision and culling support

## Asset Loading (`src/core/loaders/`)

**Loader** (`src/core/loaders/Loader.ts`)

- Base loader interface and utilities

**GLTFLoader** (`src/core/loaders/GLTFLoader.ts`)

- Complete GLTF 2.0 asset loading
- PBR material conversion
- Mesh and texture processing

## Engine Extension Patterns

### Adding New Rendering Features

When implementing new rendering features:

1. **Extend Core Enums**

   - Add new values to relevant enums (in `src/types/`)
   - Update switch statements in `Technique.ts` to handle new cases

2. **Create Specialized Render Passes**

   - Follow the pattern of passes in `src/renderer/core/passes/`
   - Extend `BaseRenderPass` or appropriate specialized base class
   - Use existing `Technique` and `Mesh` classes for consistency
   - Integrate with `RenderPassManager`

3. **Shader and Technique Integration**

   - Create `.tech` files in `assets/techniques/`
   - Implement corresponding WGSL shaders in `assets/shaders/`
   - Ensure bind group layouts match between shader and technique

4. **Resource Management Integration**
   - Extend `RenderTarget` for new texture formats/configurations
   - Add appropriate usage flags (`TEXTURE_BINDING`, `RENDER_ATTACHMENT`, etc.)
   - Handle both creation and cleanup properly

### Component Development Pattern

```typescript
// Template for new components (src/components/)
export class CustomComponent implements Component {
  private entity: Entity;
  private device: GPUDevice;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async load(data: ComponentDataType): Promise<void> {
    // Initialize GPU resources
    this.createBuffers();
    this.createBindGroups();
  }

  attach(entity: Entity): void {
    this.entity = entity;
    // Establish component relationships
  }

  update(deltaTime: number): void {
    // Per-frame logic and uniform updates
  }

  render(passEncoder: GPURenderPassEncoder): void {
    // WebGPU rendering commands
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.draw(vertexCount);
  }

  dispose(): void {
    // Clean up GPU resources
    this.uniformBuffer?.destroy();
  }
}
```

### Post-Processing Component Pattern

For new post-processing components, use the RenderPassManager pattern:

```typescript
// Reference: src/components/render/AntialiasingComponent.ts
export class CustomPostProcessComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  public apply(texture: GPUTextureView): GPUTextureView {
    this.setBindGroup(texture);

    // Use RenderPassManager for modular execution
    this.renderPassManager.executeCustomPass(
      this.fullscreenQuadMesh,
      this.technique,
      this.bindGroup!,
      this.result,
    );

    return this.result.getView();
  }
}
```

## WebGPU Integration Patterns

**Render Pass Structure**

```typescript
// All manual beginRenderPass logic has been eliminated
// Use BaseRenderPass or RenderPassManager instead
const pass = new CustomRenderPass(config, mesh, technique);
renderPassManager.executeDynamicPass(pass);
```

**Resource Binding**

```typescript
// Use factories for consistent resource creation
const bindGroup = BindGroupFactory.createBindGroup('resource_name', layout, entries);

const pipeline = PipelineFactory.createRenderPipeline(technique, vertexLayout);
```

## Development Status & Roadmap

### Current Features

- ✅ Modular render pass system (fully implemented)
- ✅ Deferred rendering pipeline with G-buffer
- ✅ PBR materials with metallic-roughness workflow
- ✅ Image-Based Lighting (IBL) with environment maps
- ✅ ECS architecture with hierarchical transforms
- ✅ GLTF model loading and rendering
- ✅ Post-processing (FXAA, tone mapping, SSAO)
- ✅ Normal mapping and tangent space calculations
- ✅ MSAA (4x Multisample Anti-Aliasing) with manual depth resolve
- ✅ Centralized GPU utilities and resource management
- ✅ Complete elimination of manual beginRenderPass logic

### Planned Enhancements (See TODO file)

- 🔄 Enhanced lighting (shadows, multiple light types)
- 🔄 Advanced post-processing (bloom, blur effects, distortion)
- 🔄 Performance optimizations (frustum culling, instancing)
- 🔄 Additional rendering features (decals, particles, volumetric lighting)
- 🔄 Animation system integration
- 🔄 Level-of-detail (LOD) system

### Known Issues & Considerations

- Environment map sampling artifacts (mipmapping and LOD issues)
- Normal encoding precision in G-buffer
- Transform hierarchy performance with large scenes
- WebGPU compatibility across different browsers
- WebGPU validation warnings for texture usage conflicts (expected behavior)

## Best Practices

### Performance Guidelines

- Use uniform buffer updates efficiently (avoid per-frame updates when possible)
- Batch similar objects in render queues
- Implement frustum culling for large scenes
- Use appropriate texture formats and compression
- Profile GPU performance using browser dev tools
- **MSAA Considerations**: Use appropriate sample counts (4x recommended for performance/quality balance)
- **Render Pass Efficiency**: Use RenderPassManager for consistent pass execution
- **Resource Reuse**: Cache bind groups and pipelines when possible

### Code Organization

- Keep components focused on single responsibilities
- Use dependency injection for WebGPU device access
- Implement proper resource cleanup in dispose methods
- **Modular Passes**: Create specialized pass classes in `src/renderer/core/passes/`
- **Factory Usage**: Use BindGroupFactory and PipelineFactory for resource creation
- **Enum Extensions**: Always update corresponding switch statements when extending enums
- **Resource Integration**: Use engine's resource system (`Technique.get()`, `Mesh.get()`) consistently
- **Error Handling**: Follow engine patterns for resource loading and validation
- Follow consistent naming conventions for shaders and uniforms
- Document complex mathematical operations (matrix transformations, PBR calculations)
- **NEVER use manual beginRenderPass**: Always use the modular render pass system

### File Organization Patterns

```
src/
├── components/
│   ├── core/           # Core ECS components
│   └── render/         # Rendering-related components
├── core/
│   ├── ecs/           # Entity-Component-System
│   ├── engine/        # Core engine systems
│   ├── loaders/       # Asset loading
│   ├── math/          # Mathematical utilities
│   └── resources/     # Resource management
├── modules/
│   ├── core/          # Core module system
│   └── game/          # Game-specific modules
├── renderer/
│   ├── core/
│   │   ├── factories/  # Resource factories
│   │   ├── managers/   # Render management
│   │   ├── passes/     # Modular render passes
│   │   └── utils/      # GPU utilities
│   ├── culling/       # Performance optimizations
│   ├── resources/     # GPU resources
│   └── shading/       # Lighting and effects
└── types/             # TypeScript type definitions
```

## Technology Stack

| Layer                | Technologies                   |
| -------------------- | ------------------------------ |
| Graphics API         | WebGPU                         |
| Programming Language | TypeScript                     |
| Shader Language      | WGSL (WebGPU Shading Language) |
| Asset Formats        | GLTF, JSON, PNG, JPG, OBJ      |
| Build System         | Vite, ES Modules               |
| Target Platform      | WebGPU-compatible browsers     |
| Mathematics          | gl-matrix library              |

This comprehensive guide serves as both documentation and development reference for the WebGPU Engine, covering architecture, implementation details, and best practices for continued development. Remember to update this file whenever you make significant changes to the engine architecture or patterns.
