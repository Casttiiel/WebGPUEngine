# WebGPU Engine

A modern 3D rendering engine built on **WebGPU** technology, implementing physically-based rendering (PBR) with deferred shading, Entity-Component-System (ECS) architecture, and modular render pass system for real-time graphics applications.

## 🚀 Features

### Core Rendering

- **Deferred Rendering Pipeline** - G-Buffer based approach for efficient multi-light scenarios
- **Physically-Based Rendering (PBR)** - Metallic-roughness workflow with Image-Based Lighting
- **Advanced Post-Processing** - Bloom, tone mapping, FXAA anti-aliasing, and ambient occlusion
- **MSAA Support** - Multisample anti-aliasing with manual depth resolve
- **Modular Render Passes** - Extensible effects pipeline without manual `beginRenderPass` logic

### Architecture

- **Entity-Component-System (ECS)** - Modular composition of game objects
- **Module System** - Clear separation of concerns with lifecycle management
- **Resource Management** - Efficient GPU resource handling with automatic cleanup
- **Debug UI System** - Integrated Tweakpane interface for real-time parameter adjustment

### Performance

- **CPU-Based Frustum Culling** - Reliable frustum culling with world-space AABB transformation
- **Efficient Culling Algorithm** - Center + half-extents method matching GPU shader implementation
- **Quality Settings** - Adaptive rendering based on performance requirements
- **WebGPU Optimization** - Optimized for browser GPU limitations and web deployment

### Asset Support

- **GLTF 2.0** - Complete model loading with PBR materials
- **Multiple Formats** - PNG, JPG textures; OBJ meshes; JSON scenes
- **Prefab System** - Reusable entity configurations
- **Shader Pipeline** - WGSL shaders with preprocessing

## 🎯 Quick Start

### Prerequisites

- **WebGPU-compatible browser** (Chrome 113+, Edge 113+, Firefox with flag enabled)
- **Node.js** 18+ and npm

### Installation

```bash
# Clone the repository
git clone https://github.com/Casttiiel/WebGPUEngine.git
cd WebGPUEngine

# Install dependencies
npm install

# Start development server
npm run dev
```

The engine will be available at `http://localhost:5173`

### Browser Setup

**Chrome/Edge:** WebGPU is enabled by default in recent versions.

**Firefox:** Enable WebGPU by setting `dom.webgpu.enabled` to `true` in `about:config`.

## 📋 System Requirements

### Minimum Requirements

- **GPU**: DirectX 12 or Vulkan compatible graphics card
- **Browser**: Chrome 113+, Edge 113+, or Firefox 115+ (with WebGPU enabled)
- **Memory**: 4GB RAM
- **WebGPU**: Required (check compatibility at [webgpu.org](https://webgpu.org))

### Recommended

- **GPU**: Dedicated graphics card with 2GB+ VRAM
- **Browser**: Latest Chrome or Edge
- **Memory**: 8GB+ RAM

## 🏗️ Architecture Overview

The WebGPU Engine follows a modular architecture with clear separation of concerns:

```
Application Layer     │ main.ts, Engine.ts, index.html
Core Module System    │ ModuleManager, ModuleBoot, ModuleInput, ModuleEntities, ModuleRender
Scene Layer          │ Entity, Component, Transform, Render, Camera
Resource Layer       │ ResourceManager, Technique, Material, Mesh, Texture, Cubemap
WebGPU Layer         │ DeferredRenderer, RenderManagerV2, GPU utilities
```

### Key Components

- **ModuleRender** - Coordinates the rendering pipeline and post-processing effects
- **DeferredRenderer** - Implements G-Buffer based deferred rendering
- **RenderManagerV2** - Manages entity rendering with CPU-based frustum culling
- **ECS System** - Entity-Component-System for modular object composition

## 📚 Documentation

Comprehensive documentation is available in the `/docs` folder:

- **[Application Architecture](docs/app.md)** - Engine lifecycle and main loop
- **[Entity-Component-System](docs/ecs.md)** - ECS architecture and component patterns
- **[Module System](docs/modules.md)** - Module lifecycle and individual module details
- **[Rendering Pipeline](docs/render.md)** - DeferredRenderer and RenderManagerV2 architecture
- **[Resource Management](docs/resources.md)** - GPU resources and asset loading

## 🎮 Example Usage

### Creating a Simple Scene

```typescript
// Load a GLTF model with PBR materials
const scene = await Loader.loadSceneFromJSON([
  {
    components: {
      name: 'Main Camera',
      transform: {
        position: [0, 5, 10],
        rotation: [0, 0, 0],
      },
      camera: {
        fov: 75,
        controllable: true,
      },
    },
  },
  {
    gltf: 'assets/models/scene.gltf',
    components: {
      transform: {
        position: [0, 0, 0],
      },
    },
  },
]);
```

### Creating Custom Components

```typescript
export class CustomComponent extends Component {
  private device: GPUDevice;
  private uniformBuffer: GPUBuffer;

  async load(data: ComponentDataType): Promise<void> {
    // Initialize GPU resources
    this.device = GPUUtils.getDevice();
    this.uniformBuffer = this.device.createBuffer({...});
  }

  update(deltaTime: number): void {
    // Per-frame logic
  }

  dispose(): void {
    // Clean up GPU resources
    this.uniformBuffer?.destroy();
  }
}
```

## 🔧 Development

### Project Structure

```
src/
├── components/         # ECS components (core, render)
├── core/              # Core engine systems (ECS, math, resources)
├── modules/           # Module system (core, game modules)
├── renderer/          # Rendering system (passes, managers, resources)
└── types/             # TypeScript type definitions

assets/
├── materials/         # PBR material definitions (.mat files)
├── meshes/           # 3D geometry (.obj, .gltf)
├── shaders/          # WGSL shaders (.vs, .fs, .cs)
├── techniques/       # Rendering pipeline definitions (.tech files)
└── textures/         # Image assets (PNG, JPG)
```

### Build Scripts

```bash
npm run dev          # Development server with hot reload
npm run build        # Production build
npm run preview      # Preview production build
npm run lint         # ESLint code checking
```

### Debug Features

- **Real-time Debug UI** - Tweakpane interface for parameter adjustment
- **Performance Monitoring** - Draw call counters and GPU statistics
- **Entity Inspector** - Hierarchical entity and component viewer
- **Quality Settings** - Runtime graphics quality adjustment

## 🎨 Rendering Features

### Physically-Based Rendering

- **Metallic-Roughness Workflow** - Industry standard PBR materials
- **Image-Based Lighting** - Environment maps for realistic lighting
- **Energy Conservation** - Physically accurate light behavior
- **Fresnel Calculations** - Realistic surface reflections

### Advanced Effects

- **Deferred Shading** - Efficient multi-light rendering
- **Screen-Space Ambient Occlusion** - Contact shadowing
- **HDR Tone Mapping** - High dynamic range imaging
- **Temporal Anti-Aliasing** - Smooth edge rendering
- **Bloom Effects** - Glow for bright surfaces

### Performance Optimizations

- **CPU Frustum Culling** - Reliable frustum culling with immediate results
- **World-Space Transformation** - Proper AABB transformation using model matrices
- **State Management** - Optimized GPU state changes
- **MSAA Support** - Hardware anti-aliasing

## 🌐 Browser Compatibility

| Browser | Version | WebGPU Support | Status          |
| ------- | ------- | -------------- | --------------- |
| Chrome  | 113+    | Native         | ✅ Full Support |
| Edge    | 113+    | Native         | ✅ Full Support |
| Firefox | 115+    | Flag Required  | ⚠️ Experimental |
| Safari  | 18+     | Development    | 🔄 In Progress  |

**Note**: WebGPU is a cutting-edge technology. Browser support is rapidly evolving.

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Follow** the existing code style and patterns
4. **Update** documentation for new features
5. **Test** your changes thoroughly
6. **Submit** a pull request

### Development Guidelines

- Follow the existing ECS and module patterns
- Use the modular render pass system (never manual `beginRenderPass`)
- Ensure proper GPU resource cleanup (`dispose()` methods)
- Add debug UI controls for new parameters
- Optimize for WebGPU web deployment

## 🙏 Acknowledgments

- **WebGPU Working Group** - For the amazing graphics API
- **Khronos Group** - For GLTF and other open standards
- **gl-matrix** - Efficient WebGL matrix library
- **Tweakpane** - Excellent debug UI library

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/Casttiiel/WebGPUEngine/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Casttiiel/WebGPUEngine/discussions)
- **Documentation**: [/docs folder](docs/)

---

**Built with ❤️ for the WebGPU community**
