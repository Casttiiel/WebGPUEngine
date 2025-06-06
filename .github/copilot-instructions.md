# WebGpu Engine Development Guide

## Architecture Essentials

### Core Architecture Overview

#### Entity Component System (ECS)
- **Scene Structure**
  - Scenes are collections of entities and prefabs
  - Prefabs are reusable entity templates
  - Entities can have child entities (hierarchical structure)
  - Components define entity behavior

#### Resource Management System
- **Resource Types** (defined in `src/types/`)
  - Scenes
  - Prefabs
  - Entities
  - Components
  - Textures
  - Materials
  - Techniques
  - Shaders

- **Resource Loading Pattern**
  ```typescript
  // All resources use static 'get' method for loading
  const texture = await Texture.get("texturePath.png");
  const material = await Material.get("materials/pbr.mat");
  const mesh = await Mesh.get("models/mesh.gltf");
  const technique = await Technique.get("techniques/gbuffer.tech");
  ```

#### Rendering Pipeline
- **Deferred Rendering**
  - GBuffer pass (geometry information)
  - Lighting pass (PBR calculations)
  - Post-processing (antialiasing, tone mapping)

- **Material System**
  - Material contains:
    - Texture references
    - Render category
    - Technique reference
    - Shadow configuration
  - Technique defines:
    - Shader usage
    - Pipeline configuration
    - Render targets
    - Uniform requirements

### Current Technical Challenges

#### Transform Hierarchy Issues
```
Problem: Child entity transforms don't automatically update when parent moves
Current State: Manual update required for child transforms
Needed: Automatic transform hierarchy update system
```

#### Pipeline Creation Complexity
```
Current Process:
1. Material load -> Technique reference
2. RenderComponent load -> Mesh information
3. Pipeline creation needs both material and mesh info
4. Technique needs to specify render targets and uniforms

Issues:
- Pipeline creation timing is awkward (needs both material and mesh)
- Uniform specifications must exactly match shader expectations
- Cannot specify if uniforms are used in vertex or fragment shader
- Pipeline configuration is spread across multiple resources
```

### Binding Group Convention
```
Group 0: View/Camera uniforms
Group 1: Material uniforms
Group 2: Object uniforms
```

### Resource Management Patterns

#### Resource Loading System
1. Uses ResourceManager for caching
   ```typescript
   if (ResourceManager.hasResource(path)) {
       return ResourceManager.getResource(path);
   }
   ```
2. Async loading pattern for proper cleanup
   ```typescript
   const resource = new Resource(path);
   await resource.load();
   ResourceManager.setResource(path, resource);
   ```

#### GLTF Resource Challenge
```
Problem: GLTF resources don't have string paths
Current Solution: Bypass ResourceManager for GLTF resources
Needed: Better resource identification system
```

### Performance Optimizations

#### Render Manager Approach
- Stores all render-ready objects
- No scene tree traversal needed for rendering
- Direct access to renderable objects
- Transform updates handled separately

## Development Patterns

### Resource Structure and Loading
```typescript
// Resource loading examples with actual paths
const texture = await Texture.get("textures/lee.jpg");
const material = await Material.get("materials/textured.mat");
const mesh = await Mesh.get("meshes/sponza/sponza.gltf");
const technique = await Technique.get("techniques/gbuffer.tech");
```

### Component Creation
```typescript
// Adding components to entities
entity.addComponent(RenderComponent, {
    mesh: "meshes/cube.obj",
    material: "materials/textured.mat"
});
```

### Shader Development
- Use WGSL for all shader code
- Follow the binding group convention:
  - Group 0: View/Camera uniforms
  - Group 1: Material uniforms
  - Group 2: Object uniforms

## Code Organization

### Feature Modules

1. **Renderer Module** (`src/renderer/`)
   - Core rendering functionality
   - Resource management
   - Pipeline state management

2. **Components** (`src/components/`)
   - Core components (Transform, Camera)
   - Render components
   - Custom game components

3. **Core Systems** (`src/core/`)
   - Engine management
   - ECS implementation
   - Math utilities
   - Resource loading

### Core Architecture

#### Asset Structure
- **Materials** (`assets/materials/`)
  - JSON-based material definitions
  - Technique references
  - Texture mappings

- **Shaders** (`assets/shaders/`)
  - `.vs` - Vertex shaders
  - `.fs` - Fragment shaders
  - `.wgsl` - Compute shaders

- **Techniques** (`assets/techniques/`)
  - Pipeline state definitions
  - Shader combinations
  - Render state configuration

#### Pipeline Configuration
1. **GBuffer Pass**
   - Outputs: Albedo, Normal, Depth, Self-illumination
   - Uses: gbuffer.tech, gbuffer_mask.tech

2. **Lighting Pass**
   - Inputs: GBuffer textures
   - Outputs: Final lit scene
   - Supports: Point lights, Directional lights

3. **Post-Processing**
   - Antialiasing (FXAA)
   - Tone mapping
   - Custom effects

## Examples To Reference

### Asset Structure Examples
```
assets/
├── materials/
│   ├── textured.mat      # Standard PBR material
│   └── transparent.mat    # Transparent material
├── meshes/
│   ├── cube.obj
│   └── sponza/
│       ├── Sponza.bin
│       └── sponza.gltf
├── prefabs/
│   ├── cube.prefab
│   └── main_camera.prefab
├── scenes/
│   └── scene.json
├── shaders/
│   ├── gbuffer.{fs,vs}   # Deferred rendering shaders
│   ├── basic.{fs,vs}     # Basic rendering shaders
│   └── skybox.{fs,vs}    # Skybox shaders
├── techniques/
│   ├── gbuffer.tech      # Deferred rendering technique
│   ├── basic.tech        # Basic rendering technique
│   └── skybox.tech       # Skybox rendering technique
└── textures/
    ├── lee.jpg           # Diffuse texture
    ├── lee_normal.jpg    # Normal map
    └── skybox.png        # Cubemap texture
```

### Material Definition Example
```json
{
    "technique": "techniques/pbr.tech",
    "category": "solids",
    "textures": {
        "albedo": "textures/lee.jpg",
        "normal": "textures/lee_normal.jpg",
        "specular": "textures/lee_specular.jpg"
    }
}
```

### Scene Setup Example
```json
{
    "entities": [
        {
            "name": "MainCamera",
            "prefab": "prefabs/main_camera.prefab",
            "components": {
                "transform": {
                    "position": [0, 2, -5],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1]
                }
            }
        }
    ]
}
```

## Best Practices

### Code Standards
- Use TypeScript strict mode and type everything
- Write clear, maintainable, and well-documented code
- Follow the established binding group convention in shaders

### Performance Optimization
- Use instancing for repeated geometry
- Implement proper frustum culling
- Batch similar materials together
- Generate and use mipmaps for textures
- Implement proper LOD systems for complex models

### Memory Management
- Properly dispose of GPU resources
- Use texture compression when possible
- Implement resource pooling for frequently created/destroyed objects

### Error Handling
- Implement proper error handling for asset loading
- Validate shader inputs and outputs
- Handle WebGPU device lost scenarios

### Asset Creation
- Use power-of-two textures
- Implement proper UV mapping
- Follow PBR material standards
- Optimize mesh topology

## Roadmap and Future Features

### Core Engine Enhancements

#### Phase 1: Core Rendering and Performance
- **Performance Foundation**
  - Performance metrics and monitoring
  - Pipeline state optimization
  - Render key ordering (technique/material/mesh)
  - Reduced pipeline activations
  - Uniform system improvements

- **Base Lighting System**
  - Point lights without shadows
  - Directional lights without shadows
  - Ambient light
  - Light exposure control

- **Primary Optimizations**
  - AABB/CPU-based camera culling
  - Light culling optimization
  - Efficient uniform handling
  - Mesh LOD system

#### Phase 2: Advanced Rendering Features
- **Shadow Implementation**
  - Shadow mapping system
  - Directional lights with shadows
  - Point lights with shadows
  - Cascaded shadow maps

- **Post-Processing Pipeline**
  - Bloom implementation
  - Blur effects
  - Distortion category support
  - Anti-aliasing improvements

- **Material Enhancements**
  - PBR material refinements
  - Compute shader integration
  - Advanced material techniques
  - Parallax mapping

#### Phase 3: Visual Effects and Environment
- **Environmental Systems**
  - Skybox with technique support
  - Dynamic day/night cycle
  - Terrain system with Perlin noise
  - Weighted terrain support

- **Advanced Effects**
  - Volumetric lighting and god rays
  - Ambient occlusion
  - Lens flare effects
  - Camera lens dirt simulation

- **Scene Enhancement**
  - Decals system
  - Particle system
  - Instancing support
  - GLTF optimization and transformation

#### Phase 4: Animation and Physics
- **Animation System**
  - Basic animation framework
  - GLTF animation support
  - Skeletal animation
  - Animation blending

- **Physics Integration**
  - Rigid body physics
  - Collision detection
  - Soft body dynamics
  - Physics-based grass simulation

### Asset Pipeline Enhancements

#### Optimization Tools
- **Mesh Processing**
  - Automatic LOD generation
  - GLTF optimization pipeline
  - Mesh compression
  - UV optimization

- **Texture Pipeline**
  - Texture compression
  - Mipmap generation optimization
  - Normal map generation
  - Texture atlas support

#### Runtime Systems
- **Resource Management**
  - Dynamic resource loading/unloading
  - Memory pool optimization
  - Asset streaming
  - Cache management

### Additional Features

#### Audio System
- Basic audio playback
- Spatial audio support
- Sound effects system
- Music system with transitions

#### Debug and Development Tools
- Visual debugging tools
- Performance profiling
- Memory tracking
- TweakPane integration for camera and scene control

## Implementation Notes
- Each phase builds upon the previous one
- Focus on stability and performance before adding new features
- Regular testing and optimization cycles
- Documentation updates with each major feature
- Community feedback integration points

Always generate code that aligns with these practices, Roadmap and Future Features and include documentation and appropriate TypeScript typing.
Whenever a new feature is developed, make sure to update this document—both the documentation section and the Roadmap section.