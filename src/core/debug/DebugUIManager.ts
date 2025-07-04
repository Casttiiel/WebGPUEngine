import { FolderApi, Pane } from 'tweakpane';

/**
 * Manages all debug UI functionality using Tweakpane
 */
export class DebugUIManager {
  private static instance: DebugUIManager;

  private debugPane: Pane | null = null;
  private debugFolders: Map<string, FolderApi> = new Map();
  private controlRegistry: Set<string> = new Set(); // Track added controls

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Gets the singleton instance of DebugUIManager
   */
  public static getInstance(): DebugUIManager {
    if (!DebugUIManager.instance) {
      DebugUIManager.instance = new DebugUIManager();
    }
    return DebugUIManager.instance;
  }

  /**
   * Initialize the debug UI panel
   */
  public initialize(): void {
    // Initialize TweakPane
    this.debugPane = new Pane({
      title: 'Debug',
      expanded: true,
    });

    // Create a resizable container for Tweakpane
    this.makeResizable();
  }

  /**
   * Destroys the debug UI
   */
  public dispose(): void {
    if (this.debugPane) {
      this.debugPane.dispose();
      this.debugPane = null;
      this.debugFolders.clear();
      this.controlRegistry.clear(); // Clear the control registry
    }
  }

  /**
   * Creates a folder in the debug UI
   * @param name Name of the folder
   * @param expanded Whether the folder should start expanded
   */
  public addFolder(name: string, expanded: boolean = false): FolderApi | null {
    if (!this.debugPane) return null;

    let folder = this.debugFolders.get(name);
    if (!folder) {
      folder = this.debugPane.addFolder({ title: name, expanded });
      this.debugFolders.set(name, folder);
    }
    return folder;
  }

  /**
   * Adds a read-only control to a folder
   * @param folderName The name of the folder
   * @param object The object to bind to
   * @param propertyKey The property to bind
   * @param label Optional display label
   */ public addDebugControl(
    folderName: string,
    object: unknown,
    propertyKey: string,
    label?: string,
  ): void {
    if (!this.debugPane) return;

    // Create a unique key for this control to avoid duplicates
    // Use label to ensure uniqueness when multiple controls have the same property key
    const uniqueLabel = label || propertyKey;
    const controlKey = `${folderName}_${propertyKey}_${uniqueLabel}_debug`;

    // Skip creating duplicate controls, but don't return
    // This allows values to still be updated for existing controls
    if (!this.controlRegistry.has(controlKey)) {
      let folder = this.getOrCreateFolder(folderName);
      if (!folder) return;

      folder.addBinding(object as Record<string, unknown>, propertyKey, {
        label: label || propertyKey,
        readonly: true,
      });

      // Register this control to prevent duplicates
      this.controlRegistry.add(controlKey);
    }
  }

  /**
   * Adds an interactive (editable) control to a folder
   * @param folderName The name of the folder
   * @param object The object to bind to
   * @param propertyKey The property to bind
   * @param label Optional display label
   * @param options Optional configuration (min, max, step)
   */ public addInteractiveControl(
    folderName: string,
    object: unknown,
    propertyKey: string,
    label?: string,
    options?: {
      min?: number;
      max?: number;
      step?: number;
    },
  ): void {
    if (!this.debugPane) return;

    // Create a unique key for this control to avoid duplicates
    // Use label to ensure uniqueness when multiple controls have the same property key
    const uniqueLabel = label || propertyKey;
    const controlKey = `${folderName}_${propertyKey}_${uniqueLabel}_interactive`;

    // Skip creating duplicate controls, but don't return
    // This allows values to still be updated for existing controls
    if (!this.controlRegistry.has(controlKey)) {
      let folder = this.getOrCreateFolder(folderName);
      if (!folder) return;

      const bindingOptions: Record<string, unknown> = {
        label: label || propertyKey,
        readonly: false,
      };

      // Add range options if provided
      if (options) {
        if (options.min !== undefined) bindingOptions.min = options.min;
        if (options.max !== undefined) bindingOptions.max = options.max;
        if (options.step !== undefined) bindingOptions.step = options.step;
      }

      folder.addBinding(object as Record<string, unknown>, propertyKey, bindingOptions);

      // Register this control to prevent duplicates
      this.controlRegistry.add(controlKey);
    }
  }

  /**
   * Creates a subfolder within an existing folder
   * @param parentFolderName The name of the parent folder
   * @param subFolderName The name of the subfolder to create
   * @param title The display title for the subfolder
   * @param expanded Whether the folder should start expanded
   * @returns The created subfolder or null if parent doesn't exist
   */
  public addSubFolder(
    parentFolderName: string,
    subFolderName: string,
    title: string,
    expanded: boolean = false,
  ): FolderApi | null {
    if (!this.debugPane) return null;

    // Create a unique key for this subfolder
    const fullKey = `${parentFolderName}_${subFolderName}`;

    // Check if subfolder already exists
    let existingSubFolder = this.debugFolders.get(fullKey);
    if (existingSubFolder) {
      return existingSubFolder; // Return existing subfolder
    }

    // Get the parent folder
    const parentFolder = this.debugFolders.get(parentFolderName);
    if (!parentFolder) {
      console.warn(`Parent folder '${parentFolderName}' not found`);
      return null;
    }

    // Create the subfolder
    const subFolder = parentFolder.addFolder({
      title: title,
      expanded: expanded,
    });

    // Store the subfolder with a compound key
    this.debugFolders.set(fullKey, subFolder);

    return subFolder;
  }

  /**
   * Add a control to an existing folder API
   * @param folder Folder to add control to
   * @param object Object to bind
   * @param propertyKey Property to bind
   * @param label Display label
   * @param options Control options
   */
  public addFolderControl(
    folder: FolderApi,
    object: unknown,
    propertyKey: string,
    label?: string,
    options?: {
      min?: number;
      max?: number;
      step?: number;
      readonly?: boolean;
    },
  ): void {
    if (!folder) return;

    const bindingOptions: Record<string, unknown> = {
      label: label || propertyKey,
      readonly: options?.readonly !== undefined ? options.readonly : true,
    };

    // Add range options if provided
    if (options) {
      if (options.min !== undefined) bindingOptions.min = options.min;
      if (options.max !== undefined) bindingOptions.max = options.max;
      if (options.step !== undefined) bindingOptions.step = options.step;
    }

    folder.addBinding(object as Record<string, unknown>, propertyKey, bindingOptions);
  }

  /**
   * Add a control to a specific named subfolder
   * @param parentFolderName Parent folder name
   * @param subFolderName Subfolder name
   * @param object Object to bind
   * @param propertyKey Property key
   * @param label Display label
   * @param options Control options
   */
  public addControlToSubFolder(
    parentFolderName: string,
    subFolderName: string,
    object: unknown,
    propertyKey: string,
    label?: string,
    options?: {
      min?: number;
      max?: number;
      step?: number;
      readonly?: boolean;
    },
  ): void {
    if (!this.debugPane) return;

    // Create a unique key for this control to avoid duplicates
    // Use label to ensure uniqueness when multiple controls have the same property key
    const uniqueLabel = label || propertyKey;
    const controlKey = `${parentFolderName}_${subFolderName}_${propertyKey}_${uniqueLabel}_subfolder`;

    // Get the subfolder
    const fullKey = `${parentFolderName}_${subFolderName}`;
    const folder = this.debugFolders.get(fullKey);
    if (!folder) {
      console.warn(`Subfolder '${fullKey}' not found`);
      return;
    }

    // Skip creating duplicate controls, but don't return early
    // This allows values to be updated for existing controls
    if (!this.controlRegistry.has(controlKey)) {
      this.addFolderControl(folder, object, propertyKey, label, options);
      // Register this control to prevent duplicates
      this.controlRegistry.add(controlKey);
    }
  }

  /**
   * Helper to get or create a folder
   * @private
   */
  private getOrCreateFolder(folderName: string): FolderApi | null {
    let folder = this.debugFolders.get(folderName);
    if (!folder) {
      const newFolder = this.addFolder(folderName);
      if (!newFolder) {
        return null;
      }
      folder = newFolder;
    }
    return folder;
  }

  /**
   * Makes the Tweakpane panel resizable by wrapping it in a resizable container
   * @private
   */
  private makeResizable(): void {
    if (!this.debugPane) return;

    // Create a resizable container
    const resizableContainer = document.createElement('div');
    resizableContainer.id = 'tweakpane-resizable-container';
    resizableContainer.style.position = 'absolute';
    resizableContainer.style.top = '10px';
    resizableContainer.style.left = '10px';
    resizableContainer.style.zIndex = '1000';
    resizableContainer.style.resize = 'both';
    resizableContainer.style.overflow = 'auto';
    resizableContainer.style.minWidth = '250px';
    resizableContainer.style.minHeight = '200px';
    resizableContainer.style.maxWidth = '600px';
    resizableContainer.style.width = '300px';
    resizableContainer.style.height = '400px';
    resizableContainer.style.boxSizing = 'border-box';
    resizableContainer.style.padding = '0';
    resizableContainer.style.background = 'rgba(0, 0, 0, 0.1)';
    resizableContainer.style.backdropFilter = 'blur(4px)';
    resizableContainer.style.borderRadius = '5px';
    resizableContainer.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.2)';

    // Add a small handle indicator in the bottom-right corner
    const resizeHandle = document.createElement('div');
    resizeHandle.style.position = 'absolute';
    resizeHandle.style.bottom = '2px';
    resizeHandle.style.right = '2px';
    resizeHandle.style.width = '10px';
    resizeHandle.style.height = '10px';
    resizeHandle.style.cursor = 'nwse-resize';
    resizeHandle.style.backgroundImage =
      'linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.5) 50%)';
    resizeHandle.style.borderRadius = '0 0 2px 0';
    resizeHandle.style.pointerEvents = 'none'; // Allows clicks to pass through

    // Move the Tweakpane element into our resizable container
    document.body.appendChild(resizableContainer);
    resizableContainer.appendChild(resizeHandle);

    // Get the Tweakpane element and move it to our container
    const tweakpaneEl = this.debugPane.element;
    if (tweakpaneEl) {
      // Make sure the Tweakpane element fills the container
      tweakpaneEl.style.width = '100%';
      tweakpaneEl.style.height = 'calc(100% - 10px)'; // Leave room for the resize handle
      tweakpaneEl.style.overflow = 'auto';

      resizableContainer.appendChild(tweakpaneEl);
    }

    // Add a drag handle for moving the panel (optional)
    const dragHandle = document.createElement('div');
    dragHandle.style.position = 'absolute';
    dragHandle.style.top = '0';
    dragHandle.style.left = '0';
    dragHandle.style.width = '100%';
    dragHandle.style.height = '8px';
    dragHandle.style.cursor = 'move';
    dragHandle.style.backgroundColor = 'transparent';
    dragHandle.style.zIndex = '10';
    resizableContainer.appendChild(dragHandle);

    // Make the panel draggable
    this.makeDraggable(resizableContainer, dragHandle);
  }

  /**
   * Clear the control registry - useful for debugging or resetting the UI
   */
  public clearControlRegistry(): void {
    this.controlRegistry.clear();
  }

  /**
   * Get the current control registry for debugging purposes
   */
  public getControlRegistry(): Set<string> {
    return new Set(this.controlRegistry); // Return a copy
  }

  /**
   * Makes an element draggable when dragging by the specified handle
   * @param element The element to make draggable
   * @param handle The handle element that triggers the drag
   */
  private makeDraggable(element: HTMLElement, handle: HTMLElement): void {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - element.getBoundingClientRect().left;
      offsetY = e.clientY - element.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;

      element.style.left = `${Math.max(0, x)}px`;
      element.style.top = `${Math.max(0, y)}px`;
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }
}
