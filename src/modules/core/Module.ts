import { Engine } from '../../core/engine/Engine';

export abstract class Module {
  private name: string;
  private active: boolean = false;

  constructor(name: string) {
    this.name = name;
  }

  public abstract start(): Promise<boolean>;
  public abstract stop(): void;
  public abstract update(dt: number): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public renderDebug(_filter?: string): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public pushDebugLines(_filter?: string): void {}

  // Método para renderizar en el menú de debug (Tweakpane + ImGui)
  public renderInMenu(): void {
    // Cada módulo implementará su propia lógica de debug UI
    // Puede usar tanto Tweakpane (siempre visible) como ImGui (modo editor)
  }

  // Helpers para GUI (Lil-GUI)
  protected beginGUIWindow(title: string = this.name): boolean {
    const gui = Engine.getGUI();
    return gui.beginWindow(title);
  }

  protected endGUIWindow(): void {
    const gui = Engine.getGUI();
    gui.endWindow();
  }

  protected beginGUIFolder(label: string): boolean {
    const gui = Engine.getGUI();
    return gui.beginFolder(label);
  }

  protected endGUIFolder(): void {
    const gui = Engine.getGUI();
    gui.endFolder();
  }

  protected addGUIText(text: string): void {
    const gui = Engine.getGUI();
    gui.addText(text);
  }

  protected addGUISeparator(): void {
    const gui = Engine.getGUI();
    gui.addSeparator();
  }

  protected addGUISlider(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange?: (value: number) => void,
  ): number {
    const gui = Engine.getGUI();
    return gui.addSlider(label, value, min, max, onChange);
  }

  protected addGUICheckbox(
    label: string,
    value: boolean,
    onChange?: (value: boolean) => void,
  ): boolean {
    const gui = Engine.getGUI();
    return gui.addCheckbox(label, value, onChange);
  }

  protected addGUIButton(label: string, onClick?: () => void): boolean {
    const gui = Engine.getGUI();
    return gui.addButton(label, onClick);
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
