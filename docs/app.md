# Application Architecture: main.ts and Engine.ts

## Overview

The WebGPU Engine uses a modular architecture where `main.ts` acts as the entry point and main loop controller, while `Engine.ts` manages all the engine's systems and modules.

---

## 📱 main.ts - Entry Point and Main Loop

### **Purpose**

`main.ts` is the application's entry file that:

- Initializes the engine
- Executes the main rendering loop
- Manages the user interface (loader)
- Handles critical initialization errors

### **Main Functionalities**

#### 1. **Engine Initialization**

```typescript
await Engine.start();
```

- Invokes asynchronous engine initialization
- Sets up WebGPU and all necessary systems

#### 2. **Main Rendering Loop**

```typescript
function frame(now: number) {
  now *= 0.001; // Convert to seconds
  const deltaTime = now - then; // Calculate elapsed time
  then = now;

  if (!Engine.isEngineRestarting()) {
    Engine.update(deltaTime); // Update game logic
    Engine.render(); // Render the frame
    Time.updateFPSDisplay(deltaTime); // Update FPS counter
  }

  requestAnimationFrame(frame); // Request next frame
}
```

**Loop characteristics:**

- **Time control**: Calculates deltaTime for consistent updates
- **Safety**: Verifies the engine is not restarting before execution
- **Rendering**: Separates update logic from rendering
- **Recursion**: Uses `requestAnimationFrame` for monitor synchronization

#### 3. **UI Management**

- **Loader**: Hides the loading indicator when the engine is ready
- **States**: Responds to different engine states (loading, ready, error)

#### 4. **Error Handling**

```typescript
catch (error) {
    console.error('Error starting engine:', error);
    // Hide loader in case of error
}
```

---

## 🔧 Engine.ts - Engine Core

### **Purpose**

`Engine.ts` is the central class that:

- Coordinates all system modules
- Manages the engine lifecycle
- Provides global access to subsystems
- Controls quality configurations

### **Modular Architecture**

#### **Main Modules**

```typescript
private static _modules: ModuleManager;      // Module manager
private static _render: ModuleRender;        // Rendering system
private static _entities: ModuleEntities;    // ECS system
private static _camera_mixer: ModuleCameraMixer; // Camera management
private static _input: ModuleInput;          // Input system
```

#### **Support Systems**

- **DebugUI**: Debug interface with Tweakpane
- **ResourceManager**: Resource management
- **QualitySettings**: Graphics quality configurations

### **Main Functionalities**

#### 1. **Initialization (`start()`)**

```typescript
public static async start(): Promise<void> {
    // 1. Initialize WebGPU
    await Render.getInstance().initialize(canvas);

    // 2. Configure debug UI
    this._debugUI.initialize();

    // 3. Create and register modules
    this._modules = new ModuleManager();
    this._modules.registerSystemModule(this._render);
    // ... other modules

    // 4. Initialize all modules
    await this._modules.start();
}
```

#### 2. **Update Loop (`update()`)**

- Updates all modules with scaled deltaTime
- Renders debug controls (Tweakpane)
- Respects global timeScale for debugging

#### 3. **Rendering (`render()`)**

- Delegates rendering to the corresponding module
- Generates a complete frame using the rendering pipeline

#### 4. **Dynamic Quality System**

```typescript
private static async applyQualityPresetAndRestart(presetName): Promise<void> {
    qualitySettings.applyPreset(presetName);
    await this.restart(); // Restart engine to apply changes
}
```

**Available presets:**

- LOW, MEDIUM, HIGH, ULTRA
- Each preset adjusts MSAA, resolution, post-processing effects

#### 5. **Lifecycle Management**

**Safe Restart:**

```typescript
public static async restart(): Promise<void> {
    this.isRestarting = true;        // Pause loops
    this.stop();                     // Clean resources
    await new Promise(resolve => setTimeout(resolve, 200)); // Wait for cleanup
    await this.start();              // Reinitialize
    this.isRestarting = false;       // Resume loops
}
```

#### 6. **Integrated Debug UI**

- **Engine Controls**: TimeScale, quality buttons
- **Modules**: Each module can add its own controls
- **Duplicate Prevention**: Only initializes controls once

### **Design Patterns Used**

#### **Singleton Pattern**

```typescript
export class Engine {
  private static initialized: boolean = false;
  // ... static methods only
}
```

#### **Module Pattern**

- Each subsystem is an independent module
- `ModuleManager` coordinates the lifecycle
- Easy extension and maintenance

#### **Factory Pattern**

- `generateDynamicId()`: Generates unique IDs
- Centralized resource management

---

## 🔄 Complete Execution Flow

```
1. main.ts
   ├── Engine.start()
   ├── Initialize rendering loop
   └── Show/hide loader

2. Engine.start()
   ├── Initialize WebGPU (Render)
   ├── Configure DebugUI
   ├── Create modules (ModuleManager)
   ├── Register system modules
   └── Initialize all modules

3. Main Loop (main.ts)
   ├── Calculate deltaTime
   ├── Engine.update(deltaTime)
   │   ├── Update all modules
   │   └── Render debug UI
   ├── Engine.render()
   │   └── ModuleRender.generateFrame()
   └── requestAnimationFrame(next frame)
```

---

## 🎯 Benefits of this Architecture

### **Separation of Concerns**

- `main.ts`: Main loop and application management
- `Engine.ts`: Engine logic and system coordination

### **Modularity**

- Each system is independent and replaceable
- Easy testing of individual components

### **Scalability**

- New modules are easily registered
- Adaptive quality system

### **Debugging**

- Integrated DebugUI for all systems
- Real-time controls for parameters

### **Robustness**

- Error handling at multiple levels
- Safe engine restart
- Well-defined loading states

This architecture allows the WebGPU Engine to be both powerful and flexible, facilitating development, debugging, and code maintenance.
