import { Module } from "../core/Module";

export class ModuleInput extends Module {
    private mousePosition: { x: number; y: number } = { x: 0, y: 0 };
    private lastMousePosition: { x: number; y: number } = { x: 0, y: 0 };
    private mouseButtons: Map<number, boolean> = new Map();
    private keys: Map<string, boolean> = new Map();
    private mouseWheelDelta: number = 0;

    constructor(name: string) {
        super(name);
    }

    public async start(): Promise<boolean> {
        window.addEventListener('mousemove', this.handleMouseMove.bind(this));
        window.addEventListener('mousedown', this.handleMouseDown.bind(this));
        window.addEventListener('mouseup', this.handleMouseUp.bind(this));
        window.addEventListener('wheel', this.handleMouseWheel.bind(this));
        window.addEventListener('keydown', this.handleKeyDown.bind(this));
        window.addEventListener('keyup', this.handleKeyUp.bind(this));
        return true;
    }

    public stop(): void {
        window.removeEventListener('mousemove', this.handleMouseMove.bind(this));
        window.removeEventListener('mousedown', this.handleMouseDown.bind(this));
        window.removeEventListener('mouseup', this.handleMouseUp.bind(this));
        window.removeEventListener('wheel', this.handleMouseWheel.bind(this));
        window.removeEventListener('keydown', this.handleKeyDown.bind(this));
        window.removeEventListener('keyup', this.handleKeyUp.bind(this));
    }

    private handleMouseMove(event: MouseEvent): void {
        this.lastMousePosition = { ...this.mousePosition };
        this.mousePosition = { x: event.clientX, y: event.clientY };
    }

    private handleMouseDown(event: MouseEvent): void {
        this.mouseButtons.set(event.button, true);
    }

    private handleMouseUp(event: MouseEvent): void {
        this.mouseButtons.set(event.button, false);
    }

    private handleMouseWheel(event: WheelEvent): void {
        this.mouseWheelDelta = event.deltaY;
    }

    private handleKeyDown(event: KeyboardEvent): void {
        this.keys.set(event.code, true);
    }

    private handleKeyUp(event: KeyboardEvent): void {
        this.keys.set(event.code, false);
    }

    public update(dt: number): void {
        // Reset per-frame values
        this.mouseWheelDelta = 0;
        this.lastMousePosition = { ...this.mousePosition };
    }

    public renderDebug(): void {
        // No visual debug needed
    }

    public renderInMenu(): void {
        
    }

    // Utility methods for other modules
    public isMouseButtonPressed(button: number): boolean {
        return this.mouseButtons.get(button) || false;
    }

    public isKeyPressed(code: string): boolean {
        return this.keys.get(code) || false;
    }

    public getMousePosition(): { x: number; y: number } {
        return this.mousePosition;
    }

    public getMouseDelta(): { x: number; y: number } {
        return {
            x: this.mousePosition.x - this.lastMousePosition.x,
            y: this.mousePosition.y - this.lastMousePosition.y
        };
    }

    public getMouseWheelDelta(): number {
        return this.mouseWheelDelta;
    }
}