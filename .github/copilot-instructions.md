# WebGPU Engine Development Guide

## Purpose and Scope

The WebGPU Engine is a modern 3D rendering engine built on WebGPU technology, implementing physically-based rendering (PBR) with deferred shading, Entity-Component-System (ECS) architecture, and modular render pass system for real-time graphics applications.

## Documentation Structure

**IMPORTANT**: This engine has comprehensive documentation in the `/docs` folder. Always refer to these documents for detailed information:

- **[docs/app.md](../docs/app.md)** - Application architecture, main.ts and Engine.ts lifecycle
- **[docs/ecs.md](../docs/ecs.md)** - Entity-Component-System architecture and component patterns
- **[docs/modules.md](../docs/modules.md)** - Module system, lifecycle management, and individual module details
- **[docs/render.md](../docs/render.md)** - Rendering pipeline, DeferredRenderer, and RenderManagerV2 architecture
- **[docs/resources.md](../docs/resources.md)** - Resource management, GPU resources, and asset loading

For detailed implementation patterns and technical specifications, always consult the relevant documentation file first.

## Development Guidelines

### Documentation Reference Requirements

**When using project documentation:**

- Always mention which specific documentation file you are referencing (e.g., "Based on docs/render.md", "As documented in docs/ecs.md")
- Cite the relevant section when possible
- Reference the docs before making architectural decisions

### WebGPU Web Optimization Requirements

**All changes and implementations must be optimized for WebGPU web deployment:**

- **Performance**: Optimize for browser GPU limitations and web performance constraints targeting 2K@60fps
- **Memory Management**: Efficient GPU resource usage with proper cleanup (destroy() calls)
- **Bundle Size**: Minimize JavaScript bundle size for web delivery
- **Browser Compatibility**: Ensure WebGPU compatibility across supported browsers
- **Web Standards**: Follow web platform best practices and limitations
- **Async Loading**: Use asynchronous patterns for resource loading to avoid blocking main thread
- **GPU Limits**: Respect WebGPU device limits and capabilities
- **Shader Optimization**: Write efficient WGSL shaders optimized for web GPU drivers
- **Resource Reuse**: Always use SamplerLibrary for GPU samplers to avoid redundant creation
- **Quality Adaptation**: Leverage QualitySettings for dynamic performance scaling

## Essential Development Patterns

### Debug UI Integration

The engine uses a centralized debug UI system with `DebugUIManager`. Key integration pattern:

```typescript
// Engine owns debug UI
const debugUI = Engine.getDebugUI();

// Add controls without duplicates
debugUI.addInteractiveControl(folderName, object, propertyKey, label, options);
debugUI.addDebugControl(folderName, object, propertyKey, label); // read-only
```

### Component Development Template

```typescript
export class CustomComponent extends Component {
  private device: GPUDevice;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;

  async load(data: ComponentDataType): Promise<void> {
    // Initialize GPU resources
  }

  update(deltaTime: number): void {
    // Per-frame logic and uniform updates
  }

  dispose(): void {
    // Clean up GPU resources
    this.uniformBuffer?.destroy();
  }
}
```

### Post-Processing Component Pattern

```typescript
export class CustomPostProcessComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  public apply(texture: GPUTextureView): GPUTextureView {
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

### SamplerLibrary Integration Pattern

```typescript
export class OptimizedComponent extends Component {
  private createBindGroup(): void {
    // ✅ Always use pre-created samplers from SamplerLibrary
    const sampler = SamplerLibrary.simpleSampler; // For FXAA, bilateral filtering
    const bloomSampler = SamplerLibrary.bloom; // For bloom operations
    const diffuseSampler = SamplerLibrary.diffuse; // For albedo textures
    const aoSampler = SamplerLibrary.ambientOcclusionSampler; // For AO techniques

    // ❌ Never create samplers manually in components
    // const sampler = device.createSampler({ /* config */ });

    this.bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 1, resource: sampler }],
    });
  }
}
```

### Resource Loading Pattern

```typescript
// All resources follow this unified pattern
public static async get(pathOrData: string | DataType): Promise<ResourceType> {
  try {
    return ResourceManager.getResource<ResourceType>(path);
  } catch {
    const resource = new ResourceType(options);
    ResourceManager.registerResource(resource);
    await resource.load();
    return resource;
  }
}
```

## Development Guidelines

### Extending the Engine

1. **New Components**: Follow ECS patterns in `docs/ecs.md`
2. **New Render Passes**: Use modular pass system in `docs/render.md`
3. **New Resources**: Follow resource management patterns in `docs/resources.md`
4. **New Modules**: Follow module lifecycle in `docs/modules.md`

### Critical Rules

- **NEVER use manual beginRenderPass**: Always use the modular render pass system
- **Resource Integration**: Use `Technique.get()`, `Mesh.get()` pattern consistently
- **Debug UI**: Use Engine.getDebugUI() for all debug controls
- **GPU Resources**: Always implement proper dispose() methods
- **Enum Extensions**: Update corresponding switch statements when extending enums
- **SamplerLibrary Required**: Always use SamplerLibrary for GPU samplers, never create manually
- **Quality Settings Integration**: Use QualitySettings for adaptive rendering parameters

### Quality Settings Integration Pattern

```typescript
export class QualityAwareComponent extends Component {
  async load(): Promise<void> {
    const qualitySettings = QualitySettings.getInstance();
    const settings = qualitySettings.getSettings();

    // Adapt based on quality level
    this.isEnabled = settings.enableAO; // For AO component
    this.numMips = settings.bloomNumMips; // For bloom component
    this.resolution = settings.renderResolution; // For resolution scaling

    // Use quality-adaptive samplers
    const anisotropicLevel = settings.anisotropicFiltering || 4;
    const sampler = SamplerLibrary.getAnisotropicByLevel(anisotropicLevel);
  }
}
```

### WebGPU Optimization Patterns

```typescript
// ✅ Separate command encoders for compute/render conflicts
const computeEncoder = device.createCommandEncoder({ label: 'Compute Pass' });
// ... compute operations ...
device.queue.submit([computeEncoder.finish()]);

// ✅ Use quality-adaptive resolution
const settings = QualitySettings.getInstance().getSettings();
const scaledWidth = Math.floor(baseWidth * settings.renderResolution);

// ✅ Efficient resource management
public dispose(): void {
  this.uniformBuffer?.destroy();
  // SamplerLibrary handles sampler cleanup automatically
}
```

### File Organization

```
src/
├── components/core/        # Core ECS components
├── components/render/      # Rendering components
├── modules/core/          # Core module system
├── modules/game/          # Game-specific modules
├── renderer/core/passes/  # Modular render passes
├── renderer/core/managers/# Render management
├── types/                 # TypeScript enums and types
```

### Quality Settings Integration

Most systems adapt to quality settings automatically:

```typescript
const qualitySettings = QualitySettings.getInstance();
const msaaLevel = qualitySettings.getMSAALevel();
const formats = qualitySettings.getPostProcessingFormats();
```

### Technology Stack

- **Graphics**: WebGPU + WGSL shaders
- **Language**: TypeScript + Vite
- **Math**: gl-matrix library
- **Assets**: GLTF, JSON, PNG/JPG, OBJ
- **Target**: WebGPU-compatible browsers

This guide provides essential development patterns. For detailed technical specifications, always refer to the comprehensive documentation in the `/docs` folder.
