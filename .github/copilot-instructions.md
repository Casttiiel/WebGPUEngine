# WebGPU Engine Development Guide

## Architecture Essentials

### Core Architecture Overview

#### Entity Component System (ECS)

- **Entities**

  - Basic containers identified by unique IDs
  - Have no functionality on their own
  - Can be organized in parent-child hierarchies
  - Serve as attachment points for components

- **Components**
  - Modular pieces of functionality that attach to entities
  - Each component has a single responsibility
  - Entities can have multiple components
  - Components contain both data and behavior

## Component Types

### Core Components

#### TransformComponent

Purpose: Manages entity position, rotation and scale in 3D space.

Key features:

- Hierarchical transformations (parent-child relationships)
- Automatic propagation of transform changes
- Direct GPU uniform buffer updates
- Integration with WebGPU bind groups

#### MeshRendererComponent

Purpose: Renders 3D geometry with materials.

Key features:

- Vertex/index buffer management
- Material assignment and parameter control
- Integration with deferred rendering pipeline
- Automatic frustum culling

#### CameraComponent

Purpose: Defines viewpoints for rendering the scene.

Key features:

- Perspective and orthographic projection
- Automatic matrix calculations for shaders
- Support for deferred rendering (world position reconstruction)
- Integration with frustum culling

### Rendering Components

#### RenderComponent

Purpose: Base class for all renderable components.

Key features:

- Base functionality for all rendered objects
- Render category classification
- Visibility management
- Integration with render queue

#### SkyboxComponent

Purpose: Renders environment background using a cubemap.

Key features:

- Infinite distance rendering
- HDR environment support
- Integration with Image Based Lighting (IBL)
- Automatic depth testing configuration

## Component Lifecycle

### Initialization Phase

1. **Constructor**: Basic setup and dependency injection
2. **load(data)**: Load configuration data and initialize resources
3. **attach(entity)**: Attach to entity and establish relationships

### Runtime Phase

1. **update(deltaTime)**: Per-frame logic updates
2. **render(passEncoder)**: Rendering commands (for renderable components)
