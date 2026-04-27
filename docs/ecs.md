# Entity-Component-System (ECS)

## Overview

The WebGPU Engine implements a modern and flexible Entity-Component-System (ECS) architecture that separates data (Components) from logic (Systems) and enables modular composition of game objects (Entities). This architecture promotes code reuse, facilitates testing, and provides excellent performance.

---

## 🏗️ ECS Architecture

### **Fundamental Concepts**

#### **Entity**

- **Container**: Simple container with unique ID
- **No Logic**: Contains no behavior, only acts as aggregator
- **Composition**: Functionality defined by contained components
- **Hierarchy**: Support for parent-child relationships

#### **Component**

- **Data + Logic**: Encapsulates both data and specific behavior
- **Specialization**: Each component has a single responsibility
- **Reuse**: Can be combined to create complex behaviors

#### **System**

- **Processing**: Handled by modules that process components
- **Coordination**: `ModuleEntities` acts as main system

---

## 🎯 Entities (Entity)

### **Entity Class**

```typescript
export class Entity {
  public readonly id: number; // Auto-generated unique ID
  private components: Map<string, Component>; // Associated components
  private parent: Entity | null; // Parent entity
  private children: Entity[]; // Child entities
}
```

### **Main Functionalities**

#### **Component Management:**

```typescript
// Add component
entity.addComponent('transform', new TransformComponent());

// Get component
const transform = entity.getComponent('transform') as TransformComponent;

// Check existence
if (entity.hasComponent('render')) {
  /* ... */
}

// Remove component
entity.removeComponent('transform');
```

#### **Hierarchies:**

```typescript
// Establish parent-child relationship
parentEntity.addChildren(childEntity);

// Navigation
const parent = entity.getParent();
const children = entity.getChildren();
```

#### **Identification:**

```typescript
// Friendly name (uses NameComponent if exists)
const name = entity.getName(); // "Player" or "Entity_123"

// Complete representation
console.log(entity.toString()); // "Entity(Player, id=123)"
```

### **Integrated Debug UI**

Each entity can render its components in the debug UI:

```typescript
public renderInMenu(parentFolder: string = 'entities'): void {
    // Create folder for entity
    const entityFolder = debugUI.addSubFolder(parentFolder, entityKey, entityName);

    // Add information for each component
    this.components.forEach((component, componentName) => {
        component.renderInMenu(); // Allow component to add its controls
    });

    // Render child entities recursively
    for (const child of this.children) {
        child.renderInMenu(folderKey);
    }
}
```

---

## 🔧 Components (Component)

### **Base Component Class**

```typescript
export abstract class Component {
  private owner!: Entity; // Entity that owns this component

  // Required abstract methods
  public abstract load(data: unknown): Promise<void>; // Load initial data
  public abstract update(dt: number): void; // Per-frame update
  public abstract renderDebug(): void; // Debug rendering

  // Optional methods
  public renderInMenu(): void {} // Debug UI (Tweakpane)

  // Ownership management
  public setOwner(owner: Entity): void;
  public getOwner(): Entity;
}
```

### **Component Lifecycle**

1. **Creation**: `new ComponentType()`
2. **Assignment**: `entity.addComponent(name, component)`
3. **Loading**: `component.load(data)` - Asynchronous initialization
4. **Registration**: `ModuleEntities.addComponentToManager()` - System registration
5. **Update**: `component.update(dt)` - Each frame
6. **Debug**: `component.renderDebug()` / `renderInMenu()` - Debug info

---

## 📦 System Components

### **1. Core Components**

#### **NameComponent**

```typescript
export class NameComponent extends Component {
  private name: string = '';

  public async load(data: string): Promise<void> {
    this.name = data;
  }

  public getName(): string {
    return this.name;
  }
}
```

**Purpose:**

- Provides readable names for entities
- Used in debug UI and logging
- Simple string storage

**Usage:**

```json
{
  "components": {
    "name": "Player Character"
  }
}
```

#### **TransformComponent**

```typescript
export class TransformComponent extends Component {
  private transform: Transform; // 3D transformation data
  private uniformBuffer: GPUBuffer; // GPU buffer for matrices
  private modelBindGroup: GPUBindGroup; // Bind group for shaders
}
```

**Purpose:**

- Manages 3D position, rotation, and scale
- Support for transformation hierarchies
- Direct GPU integration (uniform buffers)

**Features:**

- **Local Transformation**: Relative to parent
- **World Transformation**: Automatically calculated
- **Hierarchical Propagation**: Updates children automatically
- **GPU Integration**: Matrices uploaded to GPU each frame

**Loading Data:**

```json
{
  "components": {
    "transform": {
      "position": [0, 1, 0],
      "rotation": [0, 45, 0],
      "scale": [1, 1, 1]
    }
  }
}
```

**Debug UI:**

- Position sliders (X, Y, Z)
- Rotation controls (Pitch, Yaw, Roll)
- Scale controls (X, Y, Z)

### **2. Rendering Components**

#### **CameraComponent**

```typescript
export class CameraComponent extends Component {
  protected camera: Camera; // 3D camera object
  private isControllable: boolean; // If it accepts user input
  private rotationSpeed: number; // Rotation speed
}
```

**Purpose:**

- Defines viewpoints in the 3D world
- Controls view and projection matrices
- Support for optional FPS controls

**Features:**

- **Projection Parameters**: FOV, near/far planes, aspect ratio
- **Look-At**: Positioning with target and up vector
- **FPS Controls**: WASD movement + mouse (optional)
- **Viewport**: Rendering region configuration

**Loading Data:**

```json
{
  "components": {
    "camera": {
      "fov": 75,
      "near": 0.1,
      "far": 1000,
      "position": [0, 5, 10],
      "target": [0, 0, 0],
      "up": [0, 1, 0],
      "controllable": true,
      "viewport": { "width": 1920, "height": 1080 }
    }
  }
}
```

#### **RenderComponent**

```typescript
export class RenderComponent extends Component {
  private isVisible: boolean; // Object visibility
  private parts: MeshPartType[]; // List of mesh/material pairs
}
```

**Purpose:**

- Makes an entity renderable
- Manages meshes and materials
- Integration with rendering system

**Features:**

- **Multi-Mesh**: Support for multiple parts per entity
- **Visibility**: Rendering control per part
- **Render Manager**: Automatic registration in rendering system
- **Material/Mesh Pairing**: Each part has its specific material

**Loading Data:**

```json
{
  "components": {
    "render": {
      "meshes": [
        {
          "mesh": "assets/meshes/cube.obj",
          "material": "assets/materials/textured.mat",
          "visible": true
        }
      ]
    }
  }
}
```

### **3. Lighting Components**

#### **PointLightComponent**

```typescript
export class PointLightComponent extends Component {
  private color: vec3; // RGB light color
  private intensity: number; // Light intensity
  private range: number; // Range reach
  private uniformBuffer: GPUBuffer; // GPU buffer for light data
}
```

**Purpose:**

- Omnidirectional point lights
- Distance-based attenuation
- Integration with deferred rendering

**Features:**

- **HDR Color**: Color values above 1.0
- **Physical Attenuation**: Realistic quadratic falloff
- **Debug Visualization**: Debug sphere for range
- **GPU Uniforms**: Data automatically uploaded

#### **SpotLightComponent**

```typescript
export class SpotLightComponent extends Component {
  private color: vec3; // Light color
  private intensity: number; // Intensity
  private range: number; // Maximum range
  private angle: number; // Cone angle (degrees)
  private softness: number; // Edge softness
}
```

**Purpose:**

- Directional cone-shaped lights
- Directional projection with angular falloff
- Ideal for flashlights, spotlights, etc.

### **4. Post-Processing Components**

#### **ToneMappingComponent**

```typescript
export class ToneMappingComponent extends Component {
  private exposure: number; // Image exposure
  private gamma: number; // Gamma correction
  private algorithm: string; // Tone mapping algorithm
}
```

**Purpose:**

- Converts HDR to LDR
- Exposure and gamma control
- Multiple algorithms available

#### **AntialiasingComponent**

```typescript
export class AntialiasingComponent extends Component {
  private technique: Technique; // FXAA shader
  private enabled: boolean; // Effect state
}
```

**Purpose:**

- Post-processing anti-aliasing (FXAA)
- Improves visual quality without MSAA cost
- Applied at end of pipeline
- Uses optimized SamplerLibrary.simpleSampler for performance

#### **AmbientOcclusionComponent**

```typescript
export class AmbientOcclusionComponent extends Component {
  private aoTechnique: Technique; // SSAO shader
  private bilateralFilterTechnique: Technique; // Bilateral filter for quality
  private rawAOTarget: RenderTarget; // Raw AO result
  private isEnabled: boolean; // Quality-based enablement
}
```

**Purpose:**

- Screen Space Ambient Occlusion (SSAO) for realistic shadowing
- Two-pass process: Raw AO generation + bilateral filtering
- Quality-adaptive configuration based on performance settings
- Uses optimized SamplerLibrary.ambientOcclusionSampler

**Features:**

- **Quality Integration**: Automatically disabled on LOW quality setting
- **Resolution Scaling**: AO computed at reduced resolution for performance
- **Bilateral Filtering**: High-quality noise reduction pass
- **WebGPU Optimization**: Separate command encoders prevent texture usage conflicts

#### **ScreenSpaceReflections Component**

```typescript
export class ScreenSpaceReflections extends Component {
  private technique: Technique; // SSR ray marching shader
  private composeTechnique: Technique; // SSR compositing shader
  private ssrResult: RenderTarget; // Reflection results
  private reflectionMask: RenderTarget; // Reflection mask
  private enabled: boolean; // Quality-based enablement

  // SSR Parameters
  private intensity: number; // Reflection intensity
  private stepSize: number; // Ray marching step size
  private maxSteps: number; // Maximum ray steps
  private maxDistance: number; // Maximum reflection distance
  private thickness: number; // Surface thickness
}
```

**Purpose:**

- Real-time Screen Space Reflections for realistic surface reflections
- Ray marching in screen space for accurate reflection calculations
- Compositing pipeline for proper integration with lighting
- Quality-adaptive parameters for performance optimization

**Features:**

- **Ray Marching**: Efficient screen-space ray tracing implementation
- **Quality Controls**: Adjustable parameters for performance vs quality balance
- **Compositing Pipeline**: Proper blending with lighting and G-Buffer data
- **Debug Integration**: Real-time parameter adjustment through debug UI
- **Performance Optimization**: Early ray termination and optimized sampling

#### **BloomComponent**

```typescript
export class BloomComponent extends Component {
  // Compute shaders and pipelines
  private downsampleShader: GPUShaderModule;
  private upsampleShader: GPUShaderModule;
  private combineShader: GPUShaderModule;
  private downsamplePipeline: GPUComputePipeline;
  private upsamplePipeline: GPUComputePipeline;
  private combinePipeline: GPUComputePipeline;

  // Mip chain and result textures
  public mipChain: RenderTarget[]; // Progressive downsampling chain
  public accumChain: RenderTarget[]; // Accumulation textures for upsample
  private fullSizeResult: RenderTarget; // Final full-size bloom result
  private finalCombinedResult: RenderTarget; // Final combined result (original + bloom)
  private numMips: number; // Number of mips (3-8 range)
}
```

**Purpose:**

- High-performance bloom effect using Compute Shaders
- Implements Call of Duty: Advanced Warfare technique with GPU optimization
- Progressive downsampling and upsampling for efficient glow effect

**Features:**

- **Compute-Based**: Uses WebGPU compute shaders for maximum performance
- **Mip Chain**: Progressive resolution reduction for efficient processing
- **Separate Submissions**: Each compute pass uses dedicated command encoder for proper synchronization
- **Quality Adaptive**: Number of mips and parameters adjust based on quality settings
- **COD Advanced Warfare Technique**: Industry-proven bloom algorithm implementation

**Technical Implementation:**

- **Three-Phase Process**: Downsample → Upsample → Combine
- **WebGPU Synchronization**: Separate command encoder submissions prevent race conditions
- **Dynamic Bind Groups**: Runtime creation for flexibility across different mip counts
- **Memory Efficient**: Reuses textures and properly manages GPU resources

---

## 📁 Loading System

### **Loader.ts - Main Loader**

#### **Loading from JSON:**

```typescript
public static async loadSceneFromJSON(json: SceneDataType): Promise<void> {
    for (const entityData of json) {
        await this.loadEntityFromJSON(entityData);
    }
}
```

#### **Entity Loading:**

```typescript
public static async loadEntityFromJSON(json: EntityDataType, parent?: Entity): Promise<Entity> {
    const entity = new Entity();

    // 1. Establish hierarchy
    if (parent) {
        parent.addChildren(entity);
    }

    // 2. Process prefabs
    if (json.prefab) {
        const prefabJson = await ResourceManager.loadPrefab(json.prefab);
        json.components = {...json.components, ...prefabJson.components};
    }

    // 3. Process GLTF
    if (json.gltf) {
        const gltfEntities = await GLTFLoader.loadGLTF(json.gltf);
        // Add GLTF entities as children
    }

    // 4. Load components
    await this.loadComponentFromJSON(json, entity);

    // 5. Load child entities
    for (const childData of json.children ?? []) {
        await this.loadEntityFromJSON(childData, entity);
    }

    return entity;
}
```

### **Component Factory:**

```typescript
public static createComponentFromJSON(type: string): Component {
    switch (type) {
        case 'name': return new NameComponent();
        case 'transform': return new TransformComponent();
        case 'camera': return new CameraComponent();
        case 'render': return new RenderComponent();
        case 'point_light': return new PointLightComponent();
        case 'spot_light': return new SpotLightComponent();
        // ... more components
        default:
            throw new Error(`Unknown component type: ${type}`);
    }
}
```

### **Data Formats**

#### **JSON Scene Structure:**

```json
[
  {
    "components": {
      "name": "Main Camera",
      "transform": {
        "position": [0, 5, 10],
        "rotation": [0, 0, 0]
      },
      "camera": {
        "fov": 75,
        "near": 0.1,
        "far": 1000,
        "controllable": true
      }
    }
  },
  {
    "prefab": "assets/prefabs/cube.prefab",
    "components": {
      "transform": {
        "position": [2, 0, 0]
      }
    }
  }
]
```

#### **Prefabs:**

```json
{
  "components": {
    "name": "Standard Cube",
    "transform": {
      "position": [0, 0, 0],
      "scale": [1, 1, 1]
    },
    "render": {
      "meshes": [
        {
          "mesh": "assets/meshes/cube.obj",
          "material": "assets/materials/textured.mat"
        }
      ]
    }
  }
}
```

---

## 🔄 Management and Processing

### **ModuleEntities - ECS System**

#### **Object Managers:**

```typescript
class ObjectManager {
  private list: Component[]; // List of components of same type

  public updateAll(delta: number): void {
    for (const component of this.list) {
      component.update(delta);
    }
  }

  public getList(): Component[] {
    return this.list;
  }
}
```

**Getting all components of a given type from outside the module:**

```typescript
// Returns null if no component of this type is registered
const list = Engine.getEntities().getObjectManagerByName('bloom')?.getList() ?? [];
for (const comp of list) {
  (comp as BloomComponent).resize();
}
```

This pattern is how `ModuleRender.onResolutionUpdated()` resizes every post-processing component without having hard references to each one.

#### **Categorization:**

- **`omToUpdate`**: Components that need `update()`
- **`omToRenderDebug`**: Components with debug information
- **`omGeneral`**: General registry by component type

### **Processing Flow:**

#### **Initialization:**

```
1. ModuleBoot loads scene.json
2. Loader.loadSceneFromJSON()
   ├── For each entity in JSON:
   │   ├── Create Entity()
   │   ├── Process prefabs/GLTF
   │   ├── Load components
   │   └── Process child entities
   └── Register in ModuleEntities
```

#### **Runtime (each frame):**

```
1. ModuleEntities.update(dt)
   ├── For each ObjectManager in omToUpdate:
   │   └── objectManager.updateAll(dt)
   └── Update debug counters

2. ModuleEntities.renderDebug()
   ├── For each ObjectManager in omToRenderDebug:
   │   └── objectManager.renderDebugAll()
   └── Render debug UI
```

---

## 🎯 ECS System Advantages

### **Modularity**

- **Reusable Components**: A `TransformComponent` works for any entity
- **Composition vs Inheritance**: Flexibility without complex hierarchies
- **Easy Extension**: New components integrate automatically

### **Performance**

- **Cache Friendly**: Components of same type processed together
- **Selective Updates**: Only needed components are updated
- **GPU Integration**: Uniform buffers managed automatically

### **Debugging**

- **Introspection**: Easy visualization of entities and components
- **Debug UI**: Each component can expose its parameters
- **Visual Hierarchies**: Clear parent-child structure in debug

### **Flexibility**

- **Data-Driven**: Scenes defined in JSON
- **Prefabs**: Configuration reuse
- **GLTF Integration**: Complex model loading
- **Runtime Changes**: Add/remove components dynamically

---

## 🚀 Practical Examples

### **Simple Entity (Static Cube):**

```json
{
  "components": {
    "name": "Static Cube",
    "transform": {
      "position": [0, 0, 0]
    },
    "render": {
      "meshes": [{ "mesh": "cube.obj", "material": "basic.mat" }]
    }
  }
}
```

### **Complex Entity (Controllable Camera):**

```json
{
  "components": {
    "name": "Player Camera",
    "transform": {
      "position": [0, 5, 10]
    },
    "camera": {
      "fov": 75,
      "controllable": true
    }
  }
}
```

### **Entity with Hierarchy:**

```json
{
  "components": {
    "name": "Car",
    "transform": { "position": [0, 0, 0] },
    "render": { "meshes": [{ "mesh": "car_body.obj", "material": "car.mat" }] }
  },
  "children": [
    {
      "components": {
        "name": "Front Left Wheel",
        "transform": { "position": [-1, 0, 1] },
        "render": { "meshes": [{ "mesh": "wheel.obj", "material": "rubber.mat" }] }
      }
    }
  ]
}
```

This ECS system provides a solid and flexible foundation for the WebGPU Engine, enabling the creation of complex entities through composition of simple and specialized components.

---

## 📨 Message System

Inspired by the C++ engine's `sendMsg` pattern. Allows decoupled communication between components of the **same entity** without direct references between them.

### **Architecture**

- **`MsgType`** (`src/types/MsgType.enum.ts`) — Enum of all message types.
- **`IMsg<T>`** (`src/core/ecs/Msg.ts`) — Generic message wrapper with `type` + `payload`.
- **`Msg`** — Factory helpers to build messages without repeating the type.
- **`MsgDispatcher`** (`src/core/ecs/MsgDispatcher.ts`) — Global registry. Maps `MsgType → [{componentKey, handler}]`.
- **`entity.sendMsg(msg)`** — Dispatches a message to all subscribed components that the entity owns.

### **Message Types**

| Type             | Direction | Description                                           |
| ---------------- | --------- | ----------------------------------------------------- |
| `DAMAGE`         | Input     | Send damage to an entity                              |
| `ON_DAMAGED`     | Output    | Entity received damage (emitted by `HealthComponent`) |
| `ON_DEATH`       | Output    | Entity died (emitted by `HealthComponent`)            |
| `ON_HEALED`      | Output    | Entity was healed (emitted by `HealthComponent`)      |
| `ON_CONTACT`     | Event     | Physical contact (bullets, traps, etc.)               |
| `ENTITY_CREATED` | Lifecycle | Entity fully loaded and ready                         |

### **Sending a Message**

```typescript
// Deal 25 damage to an entity
entity.sendMsg(Msg.damage({ amount: 25, instigator: attackerEntity }));

// No need to know if the entity has a HealthComponent — if it doesn't, nothing happens.
```

### **Subscribing a Component**

Each component declares a `static registerMsgs()` method where it subscribes **only to the messages it cares about**:

```typescript
export class MyComponent extends Component {
  public static registerMsgs(): void {
    // Subscribe to ON_DEATH — called when the entity on which this component lives dies
    MsgDispatcher.register(MsgType.ON_DEATH, 'my_component_key', (comp, msg) => {
      const payload = (msg as IMsg<TMsgOnDeath>).payload;
      (comp as MyComponent).onEntityDied(payload.instigator);
    });
  }

  private onEntityDied(killer: Entity | null): void {
    // React to death — e.g. play animation, drop items, etc.
  }
}
```

Then register it in `Engine.registerAllMsgs()`:

```typescript
// Engine.ts → registerAllMsgs()
private static registerAllMsgs(): void {
  HealthComponent.registerMsgs();
  MyComponent.registerMsgs();
}
```

### **How Dispatch Works**

```
entity.sendMsg(Msg.damage({ amount: 10, instigator: null }))
  → MsgDispatcher.dispatch(entity, msg)
    → finds all slots registered for MsgType.DAMAGE
    → for each slot: entity.getComponent(slot.componentKey)
      → if found: slot.handler(component, msg)
        → HealthComponent.takeDamage(10, null)
          → entity.sendMsg(Msg.onDamaged({ amount: 10, currentHp: 90, instigator: null }))
            → any component subscribed to ON_DAMAGED receives the event
```

### **Adding New Messages**

1. Add entry to `MsgType` enum (`src/types/MsgType.enum.ts`)
2. Add payload interface and `Msg.xxx()` helper to `src/core/ecs/Msg.ts`
3. In the emitting component, call `this.getOwner().sendMsg(Msg.xxx(payload))`
4. In subscribing components, add `MsgDispatcher.register(...)` to their `static registerMsgs()`
5. Call `NewComponent.registerMsgs()` from `Engine.registerAllMsgs()`
