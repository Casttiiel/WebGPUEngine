# WebGPU Engine Modular System

## Overview

The WebGPU Engine uses a highly flexible modular architecture where each main system is encapsulated in independent modules. This architecture allows for easy extensibility, individual testing, and clear lifecycle management of each subsystem.

---

## 🏗️ Modular System Base Architecture

### **Base Class: Module**

All modules inherit from the abstract `Module` class:

```typescript
export abstract class Module {
  private name: string;
  private active: boolean = false;

  // Abstract methods that each module must implement
  public abstract start(): Promise<boolean>; // Initialization
  public abstract stop(): void; // Cleanup
  public abstract update(dt: number): void; // Per-frame update
  public abstract renderDebug(): void; // Debug rendering

  // Optional methods
  public renderInMenu(): void; // Debug UI (Tweakpane)
}
```

### **ModuleManager - Central Coordinator**

The `ModuleManager` acts as the orchestrator for all modules:

#### **Main Features:**

- **Lifecycle Management**: Controls module startup, update, and shutdown
- **Categorization**: Distinguishes between system and game modules
- **Game States**: Manages different gamestates with specific modules
- **JSON Configuration**: Loads configuration from external files

#### **Module Types:**

```typescript
private systemModules: Module[] = [];      // Main engine modules
private updateModules: Module[] = [];      // Modules that need update()
private renderDebugModules: Module[] = [];  // Modules with debug rendering
```

#### **Dynamic Configuration:**

- **`/data/modules.json`**: Defines which modules are updated and rendered
- **`/data/gamestates.json`**: Configures game states and associated modules

---

## 🎮 System Modules

### **1. ModuleBoot - Initializer**

#### **Purpose:**

Boot module that loads the initial scene and configures the engine's base state.

#### **Functionalities:**

- **Scene Loading**: Reads and processes `/assets/scenes/scene.json`
- **Resource Initialization**: Loads initial assets (meshes, textures, materials)
- **Base Configuration**: Sets up initial entities and components

#### **Features:**

```typescript
public async start(): Promise<boolean> {
    const response = await fetch(`/assets/scenes/scene.json`);
    const jsonData = await response.json();
    await Loader.loadSceneFromJSON(jsonData);
    return true;
}
```

- **Execution**: Only during initialization
- **Dependencies**: None (first module to execute)
- **Output**: Basic scene loaded and ready for rendering

---

### **2. ModuleEntities - ECS System**

#### **Purpose:**

Manages the complete Entity-Component-System of the engine.

#### **Functionalities:**

##### **Entity Management:**

- **Creation/Destruction**: Entity lifecycle control
- **Hierarchies**: Support for parent-child relationships
- **Unique IDs**: Automatic identifier generation

##### **Component System:**

```typescript
class ObjectManager {
  private list: Component[] = [];

  public updateAll(delta: number): void; // Updates all components
  public renderDebugAll(): void; // Renders component debug info
}
```

##### **Organization by Type:**

- **omToUpdate**: Components requiring updates
- **omToRenderDebug**: Components with debug information
- **omGeneral**: General registry by component name

#### **Features:**

- **Performance**: Efficient updating by categories
- **Debug**: Entity and component counters
- **Flexibility**: Easy addition of new component types

---

### **3. ModuleInput - Input System**

#### **Purpose:**

Captures and processes all user input (keyboard, mouse, gamepad).

#### **Functionalities:**

##### **Mouse Input:**

```typescript
private mousePosition: { x: number; y: number };
private mouseButtons: Map<MouseButton, boolean>;
private mouseWheelDelta: number;
```

##### **Keyboard Input:**

```typescript
private keys: Map<KeyCode, boolean>;
private keysLastFrame: Map<KeyCode, boolean>;  // For "just pressed" detection
```

##### **Query Methods:**

- **`isKeyPressed(key)`**: Key pressed this frame
- **`isKeyDown(key)`**: Key held down
- **`isMouseButtonDown(button)`**: Mouse button state
- **`getMouseDelta()`**: Relative mouse movement
- **`getMouseWheelDelta()`**: Mouse scroll

#### **Features:**

- **Dual State**: Tracks current and previous state to detect changes
- **Debug UI**: Real-time monitoring of all inputs
- **Normalization**: Mouse coordinates normalized to screen space

---

### **4. ModuleCameraMixer - Camera System**

#### **Purpose:**

Manages multiple cameras and smooth transitions between them.

#### **Functionalities:**

##### **Camera Mixing:**

```typescript
interface MixedCamera {
  camera: Entity;
  targetWeight: number; // Target weight (0-1)
  blendedWeight: number; // Current weight
  appliedWeight: number; // Final applied weight
  blendTime: number; // Transition time
}
```

##### **Weight System:**

- **Default Camera**: Base weight = 1.0
- **Additional Cameras**: Subtracted from available weight
- **Transitions**: Smooth interpolation between states

##### **Interpolation Types:**

- **Position**: Linear/cubic interpolation of positions
- **Rotation**: Spherical interpolation (slerp) of orientations
- **Parameters**: FOV, near/far smoothly

#### **Features:**

- **Multiple Cameras**: Support for active camera stack
- **Automatic Transitions**: Configurable blend time
- **Automatic Cleanup**: Removes cameras with 0 weight

---

### **5. ModuleRender - Rendering System**

#### **Purpose:**

Coordinates the entire rendering pipeline and visual effects of the engine.

> **Note**: This module is explained in detail in the [render.md](./render.md) document.

#### **Basic Functionalities:**

- **Deferred Rendering**: Complete deferred rendering pipeline with G-Buffer
- **Post-Processing**: Advanced effects including compute-based bloom, SSR, FXAA, tone mapping
- **Quality Management**: Dynamic graphics settings with four preset levels (LOW, MEDIUM, HIGH, ULTRA)
- **SamplerLibrary Integration**: Centralized GPU sampler management for optimal performance
- **Debug Rendering**: Comprehensive development information and real-time parameter adjustment

#### **Key Features:**

**Performance Optimization:**

- **SamplerLibrary**: Pre-created samplers eliminate redundant GPU resource creation
- **GPU Frustum Culling (primary)**: `GPUCullingManager` compute dispatch + `HZBCullingPass` occlusion culling, zero CPU readback
- **CPU Frustum Culling (fallback)**: `CPUCullingManager` used for shadow cameras and as fallback path
- **2K@60fps Target**: Optimized for high-performance rendering with dynamic resolution scaling
- **WebGPU Best Practices**: Efficient resource management and synchronization

**Quality Settings Integration:**

- **Four Quality Presets**: LOW (75% res), MEDIUM (85% res), HIGH (100% res), ULTRA (100% res + max effects)
- **Adaptive MSAA**: 1x to 4x based on quality level
- **Dynamic Effects**: AO, bloom, and other effects enabled/disabled per quality setting
- **Resolution Scaling**: Automatic render resolution adjustment for performance

**Advanced Rendering Features:**

- **Screen Space Reflections (SSR)**: Real-time reflections with ray marching
- **Compute-Based Bloom**: Industry-proven Call of Duty: Advanced Warfare technique
- **Ambient Occlusion**: SSAO with bilateral filtering for quality enhancement
- **Shadow Mapping**: Directional light shadows with optimized coordinate transforms

#### **Responsibilities:**

- Coordinate rendering passes (G-Buffer, lighting, transparent, OIT glass, SSR, volumetrics)
- Manage render targets and GPU resources with proper cleanup
- Apply quality configurations in real-time with engine restart capability
- Integrate with lighting and material systems through optimized samplers
- Execute the full post-processing chain as per-camera components

---

## 🎮 Game Modules

Game modules live in `src/modules/game/` and are registered as gamestate-scoped modules (not system modules). They are loaded/unloaded when gamestates change.

### **ModulePhysics - Physics Simulation**

#### **Purpose:**

Wraps the Rapier physics engine and bridges it with the ECS system.

#### **Functionalities:**

- Maintains a `ColliderToEntity` map and `EntityToCollider` map for O(1) lookups
- Steps the physics world each frame
- Exposes `removeColliderEntry(collider, entityId)` for safe mid-simulation removal (used when resizing box colliders)
- Provides `raycast()` for physics-based picking in the editor

---

### **ModuleEditorSelection - Scene Editor (F1)**

#### **Purpose:**

Editor mode module (toggle with **F1**) that provides the full scene-editing experience: selection, transformation gizmos, and reflection probe volume editing.

#### **Functionalities:**

##### **Entity Selection:**

- Click-to-select via physics raycast or reflection probe ray test
- Selected entity outline rendered by `GizmoRenderer`
- Escape to deselect; Delete to remove selected entity

##### **Transform Gizmos:**

```typescript
// Gizmo modes
GizmoMode.TRANSLATE   // XYZ axis arrows
GizmoMode.ROTATE      // XYZ rotation rings
GizmoMode.SCALE       // XYZ scale handles
GizmoMode.PROBE_RESIZE // Reflection probe face handles
```

Each gizmo axis maps to a `GizmoAxis` enum value (`X`, `Y`, `Z`, `PROBE_PX/NX/PY/NY/PZ/NZ`). The selected axis is highlighted, and the editor listens for mouse drag to apply the transformation.

##### **Reflection Probe Editing:**

When the selected entity has a `ReflectionProbeComponent`:

- `renderProbeVolume()` draws a filled + wireframe box via `GizmoRenderer.renderProbeBox()`
- Face-drag handles on each of the 6 faces let the artist resize the probe volume
- `startProbeFaceDrag()` / `processProbeFaceDrag()` update `ReflectionProbeComponent.extents` and resize the underlying `BoxColliderComponent`

##### **Integration:**

- Uses `ModulePhysics.raycast()` to pick entities
- Calls `GizmoRenderer.renderProbeBox()` and `GizmoRenderer.detectProbeHandleHover()` each frame
- Reads `GizmoAxis` / `GizmoMode` enums from `src/types/`

---

## 🔄 Modular Execution Flow

### **Initialization (Engine.start()):**

```
1. ModuleManager.start()
   ├── Load configuration (/data/modules.json)
   ├── Load gamestates (/data/gamestates.json)
   ├── Initialize system modules in order:
   │   ├── ModuleBoot (loads initial scene)
   │   ├── ModuleEntities (sets up ECS)
   │   ├── ModuleInput (sets up listeners)
   │   ├── ModuleCameraMixer (sets up cameras)
   │   └── ModuleRender (initializes pipeline)
   └── Activate initial gamestate
```

### **Main Loop (each frame):**

```
1. ModuleManager.update(deltaTime)
   ├── Update active gamestate
   ├── For each module in updateModules:
   │   └── module.update(deltaTime)
   └── Process state changes

2. ModuleManager.renderInMenu() (Debug UI)
   ├── For each active module:
   │   └── module.renderInMenu()
   └── Update Tweakpane controls
```

---

## 🛠️ External Configuration

### **modules.json**

```json
{
  "update": ["entities", "input", "camera_mixer", "render"],
  "render_debug": ["entities", "input", "render"]
}
```

### **gamestates.json**

```json
{
  "start": "main_game",
  "gamestates": {
    "main_game": [
      { "name": "entities" },
      { "name": "input" },
      { "name": "camera_mixer" },
      { "name": "render" }
    ]
  }
}
```

---

## 🎯 Benefits of the Modular System

### **Separation of Concerns**

- Each module has a specific and well-defined function
- Easy problem and bug identification
- Cleaner and more maintainable code

### **Scalability**

- New modules integrate easily
- Gamestate system allows different configurations
- Conditional module loading based on needs

### **Testing**

- Modules can be tested independently
- Dependency mocking is simple
- Focused debugging by system

### **Performance**

- Only necessary modules are updated
- Categorization allows specific optimizations
- Efficient resource management per module

### **Flexibility**

- JSON configuration allows changes without recompilation
- Gamestates allow different game modes
- Granular debug UI per module

---

## 🔮 Extensibility

### **Adding a New Module:**

1. **Create class** extending `Module`
2. **Implement** required abstract methods
3. **Register** in Engine.ts
4. **Configure** in modules.json
5. **Add debug UI** if necessary

### **Custom Module Example:**

```typescript
export class ModulePhysics extends Module {
  public async start(): Promise<boolean> {
    // Initialize physics engine
    return true;
  }

  public update(dt: number): void {
    // Update physics simulation
  }

  public renderInMenu(): void {
    // Add physics controls to debug UI
  }
}
```

This modular system makes the WebGPU Engine extremely flexible and easy to extend, while maintaining a clear and organized structure.
