import { Engine } from "../../core/engine/Engine";

export abstract class Module {
    private name: string;
    private active: boolean = false;

    constructor(name: string) {
        this.name = name;
    }

    public abstract start(): Promise<boolean>;
    public abstract stop(): void;
    public abstract update(dt: number): void;
    public abstract renderDebug(): void;

    // Método para renderizar en el menú de debug
    public renderInMenu(): void {
        // Cada módulo implementará su propia lógica de debug UI
    }

    // Helper para añadir controles al debug UI
    protected addDebugControl(object: unknown, propertyKey: string, label?: string): void {
        const moduleManager = Engine.getModules();
        moduleManager.addDebugControl(this.name, object, propertyKey, label);
    }

    public getName(): string {
        return this.name;
    }

    public isActive(): boolean {
        return this.active;
    }

    public setActive(active: boolean): void {
        this.active = active;
    }
}