import { Gamestate } from '../../core/engine/Gamestate';
import { FolderApi, Pane } from 'tweakpane';
import { Module } from './Module';

export class ModuleManager {
  private allModules: Module[] = [];
  private timeScale: number = 1.0;
  private systemModules: Module[] = [];
  private updateModules: Module[] = [];
  private renderDebugModules: Module[] = [];
  private startGamestate: string = '';
  private currentGamestate: Gamestate | null = null;
  private gamestates: Gamestate[] = [];
  private requestedGamestate: Gamestate | null = null;
  private debugPane: Pane | null = null;
  private debugFolders: Map<string, FolderApi> = new Map();
  private engineControlsAdded: boolean = false;

  public async start(): Promise<void> {
    // Initialize TweakPane
    this.debugPane = new Pane({
      title: 'Debug',
      expanded: true,
    });

    // Crear un contenedor redimensionable para Tweakpane
    this.makeResizable();

    // Añadir controles de Engine una sola vez
    this.addEngineControls();

    await this.loadConfig();
    await this.loadGamestates();

    await this.startModules(this.systemModules);

    if (!this.startGamestate.length) {
      this.changeToGamestate(this.startGamestate);
    }
  }

  private addEngineControls(): void {
    if (this.engineControlsAdded || !this.debugPane) return;

    // Control global de timeScale
    this.addDebugControl('Engine', { timeScale: this.timeScale }, 'timeScale');

    this.engineControlsAdded = true;
  }

  public update(dt: number): void {
    this.updateGamestate();

    for (const module of this.updateModules) {
      if (!module.isActive()) continue;
      module.update(dt * this.timeScale);
    }
  }

  public renderDebug(): void {
    for (const module of this.renderDebugModules) {
      if (!module.isActive()) continue;
      module.renderDebug();
    }
  }

  public registerGameModule(module: Module): void {
    this.allModules.push(module);
  }

  public registerSystemModule(module: Module): void {
    this.allModules.push(module);
    this.systemModules.push(module);
  }

  public getModule(name: string): Module | null {
    for (const module of this.allModules) {
      if (module.getName() === name) {
        return module;
      }
    }
    console.error('Module not found: ' + name);
    return null;
  }

  public async startModules(modules: Module[]): Promise<void> {
    for (const module of modules) {
      if (module.isActive()) continue;
      await module.start();
      module.setActive(true);
    }
  }

  public stopModules(modules: Module[]): void {
    for (const module of modules) {
      if (!module.isActive()) continue;
      module.stop();
      module.setActive(false);
    }
  }

  public changeToGamestate(gamestate: string): void {
    const gs = this.getGamestate(gamestate);
    if (!gs) {
      return;
    }

    this.requestedGamestate = gs;
  }

  public getGamestate(gamestate: string): Gamestate | null {
    for (const state of this.gamestates) {
      if (state.name === gamestate) {
        return state;
      }
    }

    return null;
  }

  public updateGamestate(): void {
    //TODO
    if (!this.requestedGamestate) {
      return;
    }

    if (this.currentGamestate) {
    }
  }

  public async loadConfig(): Promise<void> {
    const response = await fetch('/data/modules.json');
    const jsonData = await response.json();

    this.updateModules = [];
    this.renderDebugModules = [];

    for (const moduleName of jsonData['update']) {
      const module = this.getModule(moduleName);
      if (module) {
        this.updateModules.push(module);
      }
    }

    for (const moduleName of jsonData['render_debug']) {
      const module = this.getModule(moduleName);
      if (module) {
        this.renderDebugModules.push(module);
      }
    }
  }

  public async loadGamestates(): Promise<void> {
    const response = await fetch('/data/gamestates.json');
    const jsonData = await response.json();
    const jsonGamestates = jsonData['gamestates'];

    for (const gamestateName of Object.keys(jsonGamestates)) {
      const gamestate = new Gamestate(gamestateName);
      for (const jsonModule of jsonGamestates[gamestateName]) {
        const module = this.getModule(jsonModule['name']);
        if (module) {
          gamestate.push(module);
        }
      }
      this.gamestates.push(gamestate);
    }
    this.startGamestate = jsonData['start'];
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

  public addDebugControl(
    moduleName: string,
    object: unknown,
    propertyKey: string,
    label?: string,
  ): void {
    if (!this.debugPane) return;

    let folder = this.debugFolders.get(moduleName);
    if (!folder) {
      folder = this.debugPane.addFolder({ title: moduleName, expanded: false });
      this.debugFolders.set(moduleName, folder);
    }

    folder.addBinding(object as Record<string, unknown>, propertyKey, {
      label: label || propertyKey,
      readonly: true,
    });
  }

  public addInteractiveControl(
    moduleName: string,
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

    let folder = this.debugFolders.get(moduleName);
    if (!folder) {
      folder = this.debugPane.addFolder({ title: moduleName, expanded: false });
      this.debugFolders.set(moduleName, folder);
    }

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
  }

  public addSubFolder(moduleName: string, subFolderName: string): FolderApi | null {
    if (!this.debugPane) return null;

    let moduleFolder = this.debugFolders.get(moduleName);
    if (!moduleFolder) {
      moduleFolder = this.debugPane.addFolder({ title: moduleName, expanded: false });
      this.debugFolders.set(moduleName, moduleFolder);
    }

    // Create a subfolder within the module folder
    return moduleFolder.addFolder({ title: subFolderName, expanded: false });
  }

  public addSubFolderControl(
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

  public renderInMenu(): void {
    if (!this.debugPane) return;

    // Renderizar todos los módulos activos
    for (const module of this.allModules) {
      if (!module.isActive()) continue;
      module.renderInMenu();
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
    const fullKey = `${parentFolderName}_${subFolderName}`;
    this.debugFolders.set(fullKey, subFolder);

    return subFolder;
  }

  /**
   * Adds a control to a specific subfolder
   * @param parentFolderName The name of the parent folder
   * @param subFolderName The name of the subfolder
   * @param object The object to bind to
   * @param propertyKey The property to bind
   * @param label Optional label for the control
   * @param options Optional configuration for the control
   */
  public addSubFolderControl(
    parentFolderName: string,
    subFolderName: string,
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

    const fullKey = `${parentFolderName}_${subFolderName}`;
    const folder = this.debugFolders.get(fullKey);
    if (!folder) {
      console.warn(`Subfolder '${fullKey}' not found`);
      return;
    }

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
  }

  public stop(): void {
    if (this.debugPane) {
      this.debugPane.dispose();
      this.debugPane = null;
      this.engineControlsAdded = false;
    }
    this.stopModules(this.allModules);
  }
}
