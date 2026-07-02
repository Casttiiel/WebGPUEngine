import GUI from 'lil-gui';

const FOLDER_CONFIG: Record<string, { open: boolean; cssClass?: string }> = {
  'Scene':           { open: false, cssClass: 'gui-cat-scene' },
  'Lighting':        { open: false, cssClass: 'gui-cat-lighting' },
  'Atmosphere':      { open: false, cssClass: 'gui-cat-atmosphere' },
  'Post Processing': { open: false, cssClass: 'gui-cat-postprocessing' },
  'Time Control':    { open: false, cssClass: 'gui-cat-time' },
  'Statistics':      { open: false, cssClass: 'gui-cat-statistics' },
};

// lil-gui v0.21 uses "lil-" prefix on ALL class names.
// Actual classes: .lil-root  .lil-children  .lil-title  .lil-controller  .lil-name  .lil-widget  .lil-closed  .lil-disabled
const EDITOR_CSS = `
/* ── Theme variables ─────────────────────────────────────── */
.lil-gui.lil-root {
  --background-color:       #161616;
  --text-color:             #c4c4c4;
  --title-background-color: #0e0e0e;
  --title-text-color:       #e0e0e0;
  --widget-color:           #252525;
  --hover-color:            #2d2d2d;
  --focus-color:            #353535;
  --number-color:           #79b8ff;
  --string-color:           #98c379;
  --font-size:              11px;
  --input-font-size:        11px;
  --font-family:            system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-family-mono:       'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  --folder-indent:          0px;
  --spacing:                2px;
  --widget-height:          20px;
  --name-width:             44%;
  max-height: calc(100vh - 20px);
  overflow: hidden;
  box-shadow: 2px 0 16px rgba(0,0,0,0.6);
}
.lil-gui.lil-root > .lil-children {
  max-height: calc(100vh - 46px) !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
}
.lil-gui.lil-root > .lil-children::-webkit-scrollbar       { width: 3px; background: transparent; }
.lil-gui.lil-root > .lil-children::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
.lil-gui.lil-root > .lil-children::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }

/* ── Panel title "Editor" ─────────────────────────────────── */
.lil-gui.lil-root > .lil-title {
  font-size: 10px !important;
  font-weight: 700 !important;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #555 !important;
  height: auto !important;
  padding: 7px 10px !important;
}

/* ── Top-level folder headers ─────────────────────────────── */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-title {
  font-size: 11px !important;
  font-weight: 600 !important;
  letter-spacing: 0.04em;
  height: auto !important;
  padding: 6px 10px !important;
  border-top: 1px solid rgba(255,255,255,0.03) !important;
  border-bottom: 1px solid rgba(255,255,255,0.05) !important;
}

/* ── Category title colors ────────────────────────────────── */
.lil-gui.gui-cat-scene          > .lil-title { color: #d0d0d0 !important; }
.lil-gui.gui-cat-lighting       > .lil-title { color: #f5c842 !important; }
.lil-gui.gui-cat-atmosphere     > .lil-title { color: #5bc4e8 !important; }
.lil-gui.gui-cat-postprocessing > .lil-title { color: #a57af0 !important; }
.lil-gui.gui-cat-time           > .lil-title { color: #6fce84 !important; }
.lil-gui.gui-cat-statistics     > .lil-title { color: #606060 !important; font-style: italic; }

/* ── Category colored border on content area ──────────────── */
.lil-gui.gui-cat-scene          > .lil-children { border-left: 2px solid rgba(208,208,208,0.18) !important; }
.lil-gui.gui-cat-lighting       > .lil-children { border-left: 2px solid rgba(245,200,66,0.30)  !important; }
.lil-gui.gui-cat-atmosphere     > .lil-children { border-left: 2px solid rgba(91,196,232,0.30)  !important; }
.lil-gui.gui-cat-postprocessing > .lil-children { border-left: 2px solid rgba(165,122,240,0.30) !important; }
.lil-gui.gui-cat-time           > .lil-children { border-left: 2px solid rgba(111,206,132,0.30) !important; }
.lil-gui.gui-cat-statistics     > .lil-children { border-left: 2px solid rgba(96,96,96,0.18)    !important; }

/* ── Level 1: indent inside category folders ──────────────── */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-children {
  margin-left: 6px !important;
  padding-left: 8px !important;
}

/* ── Level 2: sub-folder title ────────────────────────────── */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-title {
  font-size: 10.5px !important;
  font-weight: 500 !important;
  color: #888 !important;
  height: auto !important;
  padding: 4px 8px !important;
  background: #181818 !important;
}
/* Level 2: sub-folder content */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-children {
  border-left: 1px solid rgba(255,255,255,0.06) !important;
  margin-left: 6px !important;
  padding-left: 7px !important;
}

/* ── Level 3: sub-sub-folder title ───────────────────────── */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-title {
  font-size: 10px !important;
  color: #666 !important;
  height: auto !important;
  padding: 3px 6px !important;
  background: #171717 !important;
}
/* Level 3: sub-sub-folder content */
.lil-gui.lil-root > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-children > .lil-gui > .lil-children {
  border-left: 1px solid rgba(255,255,255,0.04) !important;
  margin-left: 4px !important;
  padding-left: 5px !important;
}

/* ── Controller rows ──────────────────────────────────────── */
.lil-gui .lil-controller { border-top: none; }
.lil-gui .lil-controller > .lil-name { color: #888; }
.lil-gui .lil-controller.lil-disabled { opacity: 1; }
.lil-gui .lil-controller.lil-disabled > .lil-name { color: #555; font-size: 10.5px; }

/* ── Separators ───────────────────────────────────────────── */
.gui-separator { pointer-events: none !important; }
.gui-separator .lil-widget { display: none !important; }
.gui-separator .lil-name { width: 100% !important; min-width: 100% !important; color: #2e2e2e !important; letter-spacing: -0.02em; }
`;

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
        width: 380,
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

      this.injectEditorStyles();
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

    const existing = this.folders.get(name);
    if (existing) return false;

    const folder = this.gui.addFolder(name);
    const config = FOLDER_CONFIG[name];

    if (config?.cssClass) folder.domElement.classList.add(config.cssClass);
    if (config ? config.open : _defaultOpen) folder.open(); else folder.close();

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

    const obj = { _: '' };
    const ctrl = parent.add(obj, '_').name('───────────────').disable();
    ctrl.domElement.classList.add('gui-separator');
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
  public createChildFolder(
    parentName: string,
    childName: string,
    open: boolean = false,
  ): GUI | null {
    if (!this.initialized || !this.isVisible || !this.gui) return null;
    const parent = this.folders.get(parentName) ?? this.gui;
    const existing = this.folders.get(childName);
    if (existing) return existing;
    const folder = parent.addFolder(childName);
    if (open) folder.open();
    else folder.close();
    this.folders.set(childName, folder);
    return folder;
  }

  private injectEditorStyles(): void {
    if (document.getElementById('lil-gui-custom')) return;
    const style = document.createElement('style');
    style.id = 'lil-gui-custom';
    style.textContent = EDITOR_CSS;
    document.head.appendChild(style);
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
