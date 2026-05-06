import GUI from 'lil-gui';

/**
 * Manages Lil-GUI integration for editor UI
 * Shows UI only in editor mode (gs_editor), hidden in gameplay mode
 *
 * Lil-GUI provides a lightweight, flexible GUI system for debug/editor controls
 */
export class GUIManager {
  private static instance: GUIManager;
  private initialized: boolean = false;
  private isVisible: boolean = false;

  // Lil-GUI instances
  private gui: GUI | null = null;
  private folders: Map<string, GUI> = new Map();

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Gets the singleton instance
   */
  public static getInstance(): GUIManager {
    if (!GUIManager.instance) {
      GUIManager.instance = new GUIManager();
    }
    return GUIManager.instance;
  }

  /**
   * Initialize Lil-GUI system
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn('GuiManager already initialized');
      return;
    }

    try {
      // Create main GUI instance
      this.gui = new GUI({
        title: 'Editor',
        width: 300,
        closeFolders: false,
      });

      // Position GUI on the left side of the screen
      // Lil-gui uses inline styles, so we override them
      this.gui.domElement.style.position = 'fixed';
      this.gui.domElement.style.left = '10px';
      this.gui.domElement.style.right = 'auto';
      this.gui.domElement.style.top = '10px';

      // Start hidden (will be shown when entering editor mode)
      this.gui.hide();
      this.isVisible = false;

      this.initialized = true;
    } catch (error) {
      console.error('GUIManager: Failed to initialize', error);
      throw error;
    }
  }

  /**
   * Update state (called every frame)
   */
  public update(_deltaTime: number): void {
    // Lil-GUI doesn't need per-frame updates
    // It handles updates internally when values change
  }

  /**
   * Begin frame (no-op for Lil-GUI, kept for API compatibility)
   */
  public beginFrame(_deltaTime: number): void {
    // Not needed for Lil-GUI
  }

  /**
   * End frame and render (no-op for Lil-GUI, kept for API compatibility)
   */
  public endFrame(): void {
    // Not needed for Lil-GUI - it renders automatically
  }

  /**
   * Begin a window/folder for organizing controls.
   * Returns true only when newly created so controls are added exactly once.
   */
  public beginWindow(name: string, _defaultOpen: boolean = true): boolean {
    if (!this.initialized || !this.isVisible || !this.gui) return false;

    // Create or get folder — only populate content on first creation
    const existing = this.folders.get(name);
    if (existing) {
      return false; // Already populated, skip re-adding controls
    }

    const folder = this.gui.addFolder(name);
    folder.close(); // Start collapsed by default
    this.folders.set(name, folder);

    return true;
  }

  /**
   * End current window (no-op for Lil-GUI, kept for API compatibility)
   */
  public endWindow(): void {
    // Not needed for Lil-GUI
  }

  /**
   * Begin a collapsible folder.
   * Returns true only when newly created so controls are added exactly once.
   */
  public beginFolder(label: string): boolean {
    if (!this.initialized || !this.isVisible || !this.gui) return false;

    // Get current context (last folder or main gui)
    const parent = this.getCurrentContext();
    if (!parent) return false;

    // Create or get existing subfolder — only populate content on first creation
    const existing = this.folders.get(label);
    if (existing) {
      return false; // Already populated, skip re-adding controls
    }

    const folder = parent.addFolder(label);
    folder.close(); // Start collapsed by default
    this.folders.set(label, folder);

    return true;
  }

  /**
   * End a collapsible folder (no-op for Lil-GUI)
   */
  public endFolder(): void {
    // Not needed for Lil-GUI
  }

  /**
   * Add text label (as display monitor)
   */
  public addText(text: string): void {
    if (!this.initialized || !this.isVisible) return;

    const parent = this.getCurrentContext();
    if (!parent) return;

    // Create a read-only display object
    const obj = { value: text };
    parent.add(obj, 'value').name('').disable();
  }

  /**
   * Add dynamic text that updates automatically
   * @param object - Object containing the property to monitor
   * @param property - Property name to display
   * @param label - Label for the control
   */
  public addDynamicText<T extends object>(object: T, property: keyof T, label: string): void {
    if (!this.initialized || !this.isVisible) return;

    const parent = this.getCurrentContext();
    if (!parent) return;

    // Add controller with reference to object property
    // Lil-GUI will automatically read the property value each frame
    parent
      .add(object, property as string)
      .name(label)
      .disable()
      .listen();
  }

  /**
   * Add separator (using title)
   */
  public addSeparator(): void {
    if (!this.initialized || !this.isVisible) return;

    const parent = this.getCurrentContext();
    if (!parent) return;

    // Add a disabled empty controller as separator
    const obj = { _: '' };
    parent.add(obj, '_').name('───────────────').disable();
  }

  /**
   * Add float slider
   */
  public addSlider(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange?: (value: number) => void,
  ): number {
    if (!this.initialized || !this.isVisible) return value;

    const parent = this.getCurrentContext();
    if (!parent) return value;

    // Create object to bind to
    const obj = { value };

    const controller = parent.add(obj, 'value', min, max).name(label);

    if (onChange) {
      controller.onChange(onChange);
    }

    return obj.value;
  }

  /**
   * Add integer slider
   */
  public addSliderInt(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange?: (value: number) => void,
  ): number {
    if (!this.initialized || !this.isVisible) return value;

    const parent = this.getCurrentContext();
    if (!parent) return value;

    // Create object to bind to
    const obj = { value: Math.floor(value) };

    const controller = parent.add(obj, 'value', min, max).step(1).name(label);

    if (onChange) {
      controller.onChange((v) => onChange(Math.floor(v)));
    }

    return obj.value;
  }

  /**
   * Add checkbox
   */
  public addCheckbox(label: string, value: boolean, onChange?: (value: boolean) => void): boolean {
    if (!this.initialized || !this.isVisible) return value;

    const parent = this.getCurrentContext();
    if (!parent) return value;

    // Create object to bind to
    const obj = { value };

    const controller = parent.add(obj, 'value').name(label);

    if (onChange) {
      controller.onChange(onChange);
    }

    return obj.value;
  }

  /**
   * Add button
   */
  public addButton(label: string, onClick?: () => void): boolean {
    if (!this.initialized || !this.isVisible) return false;

    const parent = this.getCurrentContext();
    if (!parent) return false;

    // Create button object
    const obj = {
      [label]: () => {
        if (onClick) onClick();
      },
    };

    parent.add(obj, label);

    return false; // Lil-GUI buttons don't return click state
  }

  /**
   * Add color picker (RGB)
   */
  public addColorPicker(
    label: string,
    color: number[],
    onChange?: (color: number[]) => void,
  ): number[] {
    if (!this.initialized || !this.isVisible) return color;

    const parent = this.getCurrentContext();
    if (!parent) return color;

    // Convert to hex string for Lil-GUI
    const rgb = {
      r: Math.floor((color[0] ?? 0) * 255),
      g: Math.floor((color[1] ?? 0) * 255),
      b: Math.floor((color[2] ?? 0) * 255),
    };

    const obj = { color: `#${this.rgbToHex(rgb.r, rgb.g, rgb.b)}` };

    const controller = parent.addColor(obj, 'color').name(label);

    if (onChange) {
      controller.onChange((hexValue: string) => {
        const rgb = this.hexToRgb(hexValue);
        onChange([rgb.r / 255, rgb.g / 255, rgb.b / 255]);
      });
    }

    return color;
  }

  /**
   * Add input text field
   */
  public addInputText(label: string, value: string, onChange?: (value: string) => void): string {
    if (!this.initialized || !this.isVisible) return value;

    const parent = this.getCurrentContext();
    if (!parent) return value;

    // Create object to bind to
    const obj = { value };

    const controller = parent.add(obj, 'value').name(label);

    if (onChange) {
      controller.onChange(onChange);
    }

    return obj.value;
  }

  /**
   * Show GUI (when entering editor mode)
   */
  public show(): void {
    if (!this.initialized || !this.gui) return;

    this.gui.show();
    this.isVisible = true;

    // Show FPS display in editor mode
    const fpsDisplay = document.getElementById('fps-display');
    if (fpsDisplay) {
      fpsDisplay.style.display = 'block';
    }

    console.log('GUIManager: UI visible (editor mode)');
  }

  /**
   * Hide GUI (when entering gameplay mode)
   */
  public hide(): void {
    if (!this.initialized || !this.gui) return;

    this.gui.hide();
    this.isVisible = false;

    // Hide FPS display in gameplay mode
    const fpsDisplay = document.getElementById('fps-display');
    if (fpsDisplay) {
      fpsDisplay.style.display = 'none';
    }
  }

  /**
   * Check if GUI is visible
   */
  public getIsVisible(): boolean {
    return this.isVisible;
  }

  /**
   * Returns the raw lil-gui folder with the given name, or null if not found.
   * Useful for dynamic inspector panels that need to destroy and recreate controls.
   */
  public getFolder(name: string): GUI | null {
    return this.folders.get(name) ?? null;
  }

  /**
   * Removes a folder from the internal registry so it can be re-created.
   * Call this after calling folder.destroy() to keep the registry in sync.
   */
  public unregisterFolder(name: string): void {
    this.folders.delete(name);
  }

  /**
   * Creates a new folder as a child of an existing folder (or the root GUI).
   * Returns the raw lil-gui GUI instance so callers can add controls directly.
   */
  public createChildFolder(parentName: string, childName: string, open: boolean = false): GUI | null {
    if (!this.initialized || !this.isVisible || !this.gui) return null;
    const parent = this.folders.get(parentName) ?? this.gui;
    const existing = this.folders.get(childName);
    if (existing) return existing;
    const folder = parent.addFolder(childName);
    if (open) folder.open(); else folder.close();
    this.folders.set(childName, folder);
    return folder;
  }

  /**
   * Cleanup
   */
  public dispose(): void {
    if (!this.initialized) return;

    try {
      if (this.gui) {
        this.gui.destroy();
        this.gui = null;
      }

      this.folders.clear();
      this.initialized = false;
      this.isVisible = false;

      console.log('GUIManager: Disposed');
    } catch (error) {
      console.error('GUIManager: Error during disposal', error);
    }
  }

  /**
   * Get current GUI context (last added folder or main GUI)
   */
  private getCurrentContext(): GUI | null {
    if (!this.gui) return null;

    // Return the last folder in the stack, or the main GUI
    const folders = Array.from(this.folders.values());
    return folders.length > 0 ? folders[folders.length - 1] : this.gui;
  }

  /**
   * Convert RGB to hex string
   */
  private rgbToHex(r: number, g: number, b: number): string {
    return [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('');
  }

  /**
   * Convert hex string to RGB
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  }
}
