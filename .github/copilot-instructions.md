# WebGPU Engine Development Guide

## Purpose and Scope

The WebGPU Engine is a modern 3D rendering engine built on WebGPU technology, implementing physically-based rendering (PBR) with deferred shading, Entity-Component-System (ECS) architecture, and modular design for real-time graphics applications.

The engine leverages WebGPU's capabilities to deliver high-performance 3D rendering in web browsers, supporting advanced lighting models, post-processing effects, and efficient resource management for interactive 3D applications.

## System Architecture

### High-Level Architecture Layers

```
Application Layer     │ index.html, main.ts
Core Module System    │ Engine, ModuleManager, ModuleBoot, ModuleInput, ModuleEntities, ModuleRender
Scene Layer          │ Entity, Component, TransformComponent, RenderComponent, CameraComponent
Resource Layer       │ ResourceManager, Technique, Material, Mesh, Texture, Cubemap
WebGPU Layer         │ WebGPU Device & Context, RenderManager, DeferredRenderer
```

### Module System Architecture

The engine implements a module-based architecture with clear separation of concerns:

#### Core Modules

**ModuleManager**

- Coordinates all engine modules
- Manages module lifecycle (init → start → update → render → destroy)
- Centralized module registration and dependency management

**ModuleBoot**

- Engine initialization and startup procedures
- WebGPU device creation and context setup
- Initial resource loading and configuration

**ModuleInput**

- User input processing (keyboard, mouse, touch)
- Input event handling and state management
- Integration with camera and interaction systems

**ModuleEntities**

- ECS (Entity-Component-System) management
- Entity creation, destruction, and hierarchy
- Component registration and lifecycle management
- Scene graph traversal and updates

**ModuleRender**

- Graphics pipeline coordination
- Deferred rendering implementation
- Draw call management and optimization
- Post-processing effects coordination

### Module Lifecycle

```typescript
interface Module {
  init(): Promise<void>; // Initialize module resources
  start(): void; // Start module operation
  update(dt: number): void; // Per-frame updates
  render(): void; // Rendering operations
  destroy(): void; // Cleanup resources
}
```

## Entity Component System (ECS)

### Core ECS Concepts

**Entities**

- Unique containers identified by IDs
- Support hierarchical parent-child relationships
- Serve as attachment points for components
- No inherent functionality - purely organizational

**Components**

- Modular pieces of functionality and data
- Single responsibility principle
- Attach to entities to provide specific behaviors
- Can be combined for complex entity behaviors

### Component Types

#### Core Components

**TransformComponent**

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

**CameraComponent**

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

Features:

- Perspective/orthographic projection support
- Automatic matrix calculations for shaders
- Integration with deferred rendering (world position reconstruction)
- Frustum culling support

## Rendering Pipeline

### Deferred Rendering Architecture

The engine implements a G-buffer based deferred rendering pipeline:

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
- Distortion effects
- Bloom and other visual enhancements

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

### Asset Loading System

**Supported Formats**

- GLTF: 3D models with PBR materials
- PNG/JPG: Texture maps
- JSON: Scene definitions and prefabs
- OBJ: Simple mesh format

**Resource Types**

```typescript
// Core resource classes
class MeshResource {
  vertices: Float32Array;
  indices: Uint32Array;
}
class TextureResource {
  texture: GPUTexture;
  sampler: GPUSampler;
}
class MaterialResource {
  technique: Technique;
  parameters: MaterialParams;
}
class CubemapResource {
  faces: GPUTexture[];
}
```

### Technique System

Declarative shader pipeline configuration:

```json
// Example technique definition
{
  "vertex": "basic.vs",
  "fragment": "basic.fs",
  "blendMode": "OPAQUE",
  "depthMode": "LESS_EQUAL",
  "cullMode": "BACK"
}
```

### GPU Resource Management

**Buffer Management**

- Automatic uniform buffer creation and updates
- Vertex/index buffer optimization
- Memory pool allocation for efficient reuse

**Texture Management**

- Mipmap generation for environment maps
- Format optimization (RGBA8, BC compression)
- Sampler state caching

## Shader System

### WGSL Shader Architecture

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

**Bind Group Layout**

- Group 0: Camera uniforms (global)
- Group 1: Object uniforms (per-object)
- Group 2: Material textures and samplers
- Group 3: Lighting data

### Normal Mapping Implementation

```wgsl
// TBN matrix calculation and normal transformation
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
  let N = inputN;
  let T = inputT.xyz;
  let B = cross(N, T) * inputT.w;
  return mat3x3<f32>(T, B, N);
}

// Transform normal from tangent space to world space
let N_tangent_space = textureSample(txNormal, samplerState, input.Uv) * 2.0 - 1.0;
let TBN = computeTBN(normalize(input.N), input.T);
let N_world = normalize(TBN * N_tangent_space.xyz);
```

## Development Patterns

### Component Implementation Template

```typescript
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

### WebGPU Integration Patterns

**Render Pass Structure**

```typescript
// Typical render pass setup
const passEncoder = commandEncoder.beginRenderPass({
  colorAttachments: [
    {
      view: gBufferViews[0],
      loadOp: 'clear',
      storeOp: 'store',
    },
  ],
  depthStencilAttachment: {
    view: depthView,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  },
});
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

## Development Status & Roadmap

### Current Features

- ✅ Deferred rendering pipeline with G-buffer
- ✅ PBR materials with metallic-roughness workflow
- ✅ Image-Based Lighting (IBL) with environment maps
- ✅ ECS architecture with hierarchical transforms
- ✅ GLTF model loading and rendering
- ✅ Post-processing (FXAA, tone mapping)
- ✅ Normal mapping and tangent space calculations

### Planned Enhancements

- 🔄 Enhanced lighting (point lights, directional lights, shadows)
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

## Best Practices

### Performance Guidelines

- Use uniform buffer updates efficiently (avoid per-frame updates when possible)
- Batch similar objects in render queues
- Implement frustum culling for large scenes
- Use appropriate texture formats and compression
- Profile GPU performance using browser dev tools

### Code Organization

- Keep components focused on single responsibilities
- Use dependency injection for WebGPU device access
- Implement proper resource cleanup in dispose methods
- Follow consistent naming conventions for shaders and uniforms
- Document complex mathematical operations (matrix transformations, PBR calculations)

This comprehensive guide serves as both documentation and development reference for the WebGPU Engine, covering architecture, implementation details, and best practices for continued development.
