# ImGui Integration Guide

## Overview

The WebGPU Engine includes **ImGui** (via `@zhobo63/imgui-ts`) for creating immediate-mode debug and editor interfaces. ImGui complements the existing **Tweakpane** system (DebugUIManager) by providing a more flexible, window-based UI system ideal for editor modes.

---

## 🎯 Purpose

- **DebugUIManager (Tweakpane)**: Fixed-panel debug controls, always visible, optimized for runtime debugging
- **ImGuiManager (ImGui)**: Window-based editor interface, visible only in editor mode, ideal for complex tools

---

## 🏗️ Architecture

### **ImGuiManager**

The `ImGuiManager` is a singleton that manages the ImGui context and rendering lifecycle.

```typescript
export class ImGuiManager {
  public async initialize(): Promise<void>;
  public update(deltaTime: number): void;
  public beginFrame(deltaTime: number): void;
  public endFrame(): void;
  public show(): void; // Show ImGui (editor mode)
  public hide(): void; // Hide ImGui (gameplay mode)
  public dispose(): void;
}
```

### **Integration in Engine**

ImGui is integrated into the main engine loop:

```typescript
// In Engine.update()
this._imguiManager.update(dt * this._timeScale); // Begin frame
this.renderImGui(); // Render all module UIs

// In Engine.render()
this._imguiManager.endFrame(); // End frame and render
```

---

## 📝 Basic Usage

### **1. Module-Level Interface**

Each module can implement `renderImGui()` to create its editor interface:

```typescript
export class MyModule extends Module {
  public override renderImGui(): void {
    // Create a window
    if (this.beginImGuiWindow('My Module')) {
      // Add controls
      this.addImGuiText('Hello from ImGui!');

      // Add slider
      this.myValue = this.addImGuiSlider('Value', this.myValue, 0, 100, (newValue) => {
        console.log('Value changed:', newValue);
      });

      // Add checkbox
      this.myFlag = this.addImGuiCheckbox('Enable Feature', this.myFlag, (newValue) => {
        this.onFlagChanged(newValue);
      });

      // Add button
      if (this.addImGuiButton('Click Me')) {
        console.log('Button clicked!');
      }

      this.endImGuiWindow();
    }
  }
}
```

### **2. Component-Level Interface**

Components can also render ImGui interfaces:

```typescript
export class MyComponent extends Component {
  public renderImGui(): void {
    const imgui = Engine.getImGui();

    if (imgui.beginFolder('My Component')) {
      imgui.addText(`Status: ${this.status}`);

      this.intensity = imgui.addSlider('Intensity', this.intensity, 0.0, 1.0, (value) =>
        this.setIntensity(value),
      );

      imgui.endFolder();
    }
  }
}
```

---

## 🔧 Available Controls

### **Windows and Organization**

```typescript
// Create a window
if (imgui.beginWindow('Window Title', true)) {
  // ... controls ...
  imgui.endWindow();
}

// Create collapsible folder
if (imgui.beginFolder('Section')) {
  // ... nested controls ...
  imgui.endFolder();
}
```

### **Display Elements**

```typescript
// Text label
imgui.addText('Hello World');

// Separator line
imgui.addSeparator();
```

### **Input Controls**

```typescript
// Float slider
const value = imgui.addSlider('Label', currentValue, 0.0, 10.0, onChange);

// Integer slider
const intValue = imgui.addSliderInt('Count', currentValue, 0, 100, onChange);

// Checkbox
const checked = imgui.addCheckbox('Enable', currentValue, onChange);

// Button
if (imgui.addButton('Click Me', onClick)) {
  // Button was clicked
}

// Text input
const text = imgui.addInputText('Name', currentValue, onChange);

// Color picker (RGB)
imgui.addColorPicker('Color', [1.0, 0.5, 0.3], onChange);
```

---

## 🎨 Styling

ImGui is configured with a dark theme optimized for editor use:

```typescript
private configureStyle(): void {
  const style = ImGui.GetStyle();

  // Window
  style.WindowRounding = 5.0;
  style.WindowBorderSize = 1.0;

  // Frame
  style.FrameRounding = 4.0;
  style.FramePadding.x = 8.0;
  style.FramePadding.y = 4.0;

  // Colors - Dark theme
  colors[ImGui.Col.WindowBg].w = 0.95;
  colors[ImGui.Col.Button] = new ImGui.ImVec4(0.25, 0.25, 0.25, 1.0);
  // ... more color configuration
}
```

---

## 🔄 Lifecycle Management

### **Editor Mode vs Gameplay Mode**

ImGui visibility is controlled by the gamestate system:

```typescript
// In ModuleBoot or gamestate manager

// Editor mode - show ImGui
ImGuiManager.getInstance().show();

// Gameplay mode - hide ImGui
ImGuiManager.getInstance().hide();
```

### **Frame Cycle**

```
1. Engine.update(dt)
   └── ImGuiManager.update(dt)
       └── ImGuiManager.beginFrame(dt)
           └── ImGui_Impl.NewFrame()
           └── ImGui.NewFrame()

2. Engine.renderImGui()
   └── ModuleManager.renderImGui()
       └── Module.renderImGui()
           └── [User creates windows and controls]

3. Engine.render()
   └── ImGuiManager.endFrame()
       └── ImGui.EndFrame()
       └── ImGui.Render()
       └── ImGui_Impl.RenderDrawData()
```

---

## 📊 Example: Render Statistics Window

```typescript
public override renderImGui(): void {
  if (this.beginImGuiWindow('Render Statistics')) {
    // Display stats
    this.addImGuiText(`FPS: ${this.fps.toFixed(2)}`);
    this.addImGuiText(`Frame Time: ${this.frameTime.toFixed(2)}ms`);

    this.addImGuiSeparator();

    // Draw call breakdown
    this.addImGuiText(`Draw Calls (Solids): ${this.drawCallsSolids}`);
    this.addImGuiText(`Draw Calls (Transparent): ${this.drawCallsTransparent}`);
    this.addImGuiText(`Total: ${this.totalDrawCalls}`);

    this.addImGuiSeparator();

    // Interactive controls
    this.vsyncEnabled = this.addImGuiCheckbox(
      'V-Sync',
      this.vsyncEnabled,
      (enabled) => this.setVSync(enabled)
    );

    if (this.addImGuiButton('Reset Stats')) {
      this.resetStatistics();
    }

    this.endImGuiWindow();
  }
}
```

---

## 📊 Example: Post-Processing Editor

```typescript
public override renderImGui(): void {
  if (this.beginImGuiWindow('Post-Processing')) {

    // Bloom controls
    if (this.beginImGuiFolder('Bloom')) {
      this.bloomIntensity = this.addImGuiSlider(
        'Intensity',
        this.bloomIntensity,
        0.0,
        2.0
      );

      this.bloomThreshold = this.addImGuiSlider(
        'Threshold',
        this.bloomThreshold,
        0.0,
        5.0
      );

      this.endImGuiFolder();
    }

    // Tone mapping controls
    if (this.beginImGuiFolder('Tone Mapping')) {
      this.exposure = this.addImGuiSlider(
        'Exposure',
        this.exposure,
        0.1,
        5.0
      );

      this.gamma = this.addImGuiSlider(
        'Gamma',
        this.gamma,
        1.0,
        3.0
      );

      this.endImGuiFolder();
    }

    this.endImGuiWindow();
  }
}
```

---

## 🎯 Best Practices

### **1. Check Visibility**

ImGui only renders when visible (editor mode):

```typescript
public renderImGui(): void {
  const imgui = Engine.getImGui();
  if (!imgui.getIsVisible()) return;

  // ... your UI code ...
}
```

**Note**: Module helpers automatically check visibility, so this is optional when using `beginImGuiWindow()`.

### **2. Always Close Windows and Folders**

```typescript
// ✅ Correct
if (this.beginImGuiWindow('Window')) {
  // ... controls ...
  this.endImGuiWindow(); // Always close
}

// ✅ Correct
if (this.beginImGuiFolder('Folder')) {
  // ... controls ...
  this.endImGuiFolder(); // Always close
}
```

### **3. Use Callbacks for Changes**

```typescript
// ✅ Preferred - callback pattern
this.value = imgui.addSlider('Value', this.value, 0, 100, (newValue) => {
  this.onValueChanged(newValue);
  this.updateGPUResources();
});

// ⚠️ Less efficient - manual check
const newValue = imgui.addSlider('Value', this.value, 0, 100);
if (newValue !== this.value) {
  this.value = newValue;
  this.updateGPUResources();
}
```

### **4. Organize with Folders**

```typescript
public renderImGui(): void {
  if (this.beginImGuiWindow('Complex System')) {

    if (this.beginImGuiFolder('Rendering')) {
      // Rendering controls
      this.endImGuiFolder();
    }

    if (this.beginImGuiFolder('Physics')) {
      // Physics controls
      this.endImGuiFolder();
    }

    if (this.beginImGuiFolder('Audio')) {
      // Audio controls
      this.endImGuiFolder();
    }

    this.endImGuiWindow();
  }
}
```

### **5. Separate Read-Only and Interactive**

```typescript
// Read-only display (statistics)
this.addImGuiText(`FPS: ${this.fps}`);
this.addImGuiText(`Memory: ${this.memoryMB}MB`);

this.addImGuiSeparator();

// Interactive controls
this.quality = this.addImGuiSliderInt('Quality', this.quality, 1, 4);
this.vsync = this.addImGuiCheckbox('V-Sync', this.vsync);
```

---

## 🔧 Advanced Usage

### **Direct ImGui Access**

For advanced scenarios, you can access ImGui directly:

```typescript
import { ImGui } from '@zhobo63/imgui-ts';

const io = Engine.getImGui().getIO();
if (io) {
  // Advanced configuration
  io.ConfigFlags |= ImGui.ConfigFlags.NavEnableGamepad;
}
```

### **Custom Window Configuration**

```typescript
const imgui = Engine.getImGui();

// Set window position
ImGui.SetNextWindowPos(new ImGui.ImVec2(100, 100), ImGui.Cond.FirstUseEver);

// Set window size
ImGui.SetNextWindowSize(new ImGui.ImVec2(400, 300), ImGui.Cond.FirstUseEver);

if (imgui.beginWindow('Custom Window')) {
  // ... controls ...
  imgui.endWindow();
}
```

---

## 🚀 Performance Considerations

### **Conditional Rendering**

Only create UI when visible:

```typescript
public renderImGui(): void {
  if (!this.beginImGuiWindow('Heavy System')) return;

  // Expensive UI creation only when window is open
  this.generateComplexUI();

  this.endImGuiWindow();
}
```

### **Update vs Render Separation**

```typescript
public update(dt: number): void {
  // Heavy computations
  this.updatePhysics(dt);
  this.updateAI(dt);
}

public renderImGui(): void {
  // Lightweight UI rendering
  if (this.beginImGuiWindow('Status')) {
    this.addImGuiText(`State: ${this.state}`);
    this.endImGuiWindow();
  }
}
```

---

## 🔗 Integration with Existing Systems

### **Tweakpane Coexistence**

Both UI systems work together:

```typescript
// Tweakpane - Always visible debug panel
public renderInMenu(): void {
  this.addDebugControl(this.stats, 'fps', 'FPS');
  this.addDebugControl(this.stats, 'drawCalls', 'Draw Calls');
}

// ImGui - Editor mode only
public renderImGui(): void {
  if (this.beginImGuiWindow('Advanced Editor')) {
    // Complex editor tools
    this.renderSceneGraph();
    this.renderMaterialEditor();
    this.endImGuiWindow();
  }
}
```

### **Component Integration**

```typescript
// In ModuleRender
public override renderImGui(): void {
  const mainCamera = Engine.getEntities().getEntityByName('MainCamera');

  if (mainCamera && this.beginImGuiWindow('Camera')) {
    // Render component interfaces
    const bloomComponent = mainCamera.getComponent('bloom');
    if (bloomComponent && typeof bloomComponent.renderImGui === 'function') {
      bloomComponent.renderImGui();
    }

    this.endImGuiWindow();
  }
}
```

---

## 📚 Additional Resources

- **ImGui Official**: [https://github.com/ocornut/imgui](https://github.com/ocornut/imgui)
- **imgui-ts Package**: [https://www.npmjs.com/package/@zhobo63/imgui-ts](https://www.npmjs.com/package/@zhobo63/imgui-ts)
- **WebGPU Engine Docs**: See `/docs` folder for complete engine documentation

---

This ImGui integration provides a powerful, flexible UI system for creating editor tools while maintaining the simplicity of Tweakpane for runtime debugging. Use ImGui for complex, window-based interfaces and Tweakpane for fixed debug panels.
