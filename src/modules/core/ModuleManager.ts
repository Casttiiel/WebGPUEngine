import { Gamestate } from "../../core/engine/Gamestate";
import { Pane } from 'tweakpane';
import { Module } from "./Module";

export class ModuleManager {
    private allModules: Module[] = [];
    private timeScale: number = 1.0;
    private systemModules: Module[] = [];
    private updateModules: Module[] = [];
    private renderDebugModules: Module[] = [];
    private startGamestate: string = "";
    private currentGamestate: Gamestate | null = null;
    private gamestates: Gamestate[] = [];
    private requestedGamestate: Gamestate | null = null;
    private debugPane: Pane | null = null;
    private debugFolders: Map<string, any> = new Map();
    private folderStates: Map<string, boolean> = new Map();
    private engineControlsAdded: boolean = false;

    public async start(): Promise<void> {
        // Initialize TweakPane
        this.debugPane = new Pane({
            title: 'Debug',
            expanded: true
        });

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
        this.addDebugControl('Engine', { timeScale: this.timeScale }, 'timeScale', {
            min: 0,
            max: 2,
            step: 0.1
        });

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
        console.error("Module not found: " + name);
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

        for (const moduleName of jsonData["update"]) {
            const module = this.getModule(moduleName);
            if (module) {
                this.updateModules.push(module);
            }
        }

        for (const moduleName of jsonData["render_debug"]) {
            const module = this.getModule(moduleName);
            if (module) {
                this.renderDebugModules.push(module);
            }
        }
    }

    public async loadGamestates(): Promise<void> {
        const response = await fetch('/data/gamestates.json');
        const jsonData = await response.json();
        const jsonGamestates = jsonData["gamestates"];

        for (const gamestateName of Object.keys(jsonGamestates)) {
            const gamestate = new Gamestate(gamestateName);
            for (const jsonModule of jsonGamestates[gamestateName]) {
                const module = this.getModule(jsonModule["name"]);
                if (module) {
                    gamestate.push(module);
                }
            }
            this.gamestates.push(gamestate);
        }
        this.startGamestate = jsonData["start"];
    }

    private getOrCreateFolder(path: string, expanded: boolean = true): any {
        if (!this.debugPane) return null;

        // Ahora solo creamos un nivel de folders
        const parts = path.split('/');
        const folderName = parts[0]; // Solo usamos el primer nivel

        if (!this.debugFolders.has(folderName)) {
            const wasExpanded = this.folderStates.get(folderName) ?? expanded;
            
            const newFolder = this.debugPane.addFolder({
                title: folderName,
                expanded: wasExpanded
            });

            this.debugFolders.set(folderName, newFolder);
            
            newFolder.on('fold', (ev: {expanded: boolean}) => {
                this.folderStates.set(folderName, ev.expanded);
            });
            
            return newFolder;
        }

        return this.debugFolders.get(folderName);
    }

    public renderInMenu(): void {
        if (!this.debugPane) return;

        // Renderizar todos los módulos activos
        for (const module of this.allModules) {
            if (!module.isActive()) continue;
            module.renderInMenu();
        }
    }

    public addDebugControl(folderPath: string, object: any, propertyKey: string, options?: any): void {
        const folder = this.getOrCreateFolder(folderPath);
        if (!folder) return;

        try {
            // Si es un objeto con valor y las opciones indican que es de solo lectura
            if (object && typeof object === 'object' && 'value' in object && options?.disabled) {
                folder.addBinding(object, 'value', {
                    ...options,
                    label: options?.label || propertyKey,
                    readonly: true
                });
            }
            // Para cualquier otro caso
            else {
                folder.addBinding(object, propertyKey, options);
            }
        } catch (error) {
            console.warn(`Failed to add debug control for ${propertyKey}:`, error);
        }
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