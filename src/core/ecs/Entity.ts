import { NameComponent } from '../../components/core/NameComponent';
import { Component } from './Component';
import { MsgDispatcher } from './MsgDispatcher';
import type { IMsg } from './Msg';
import type { EntityDataType } from '../../types/SceneData.type';

export class Entity {
  private static nextId = 0;
  public readonly id: number;
  private components: Map<string, Component> = new Map();
  private parent: Entity | null = null;
  private children: Entity[] = [];

  constructor() {
    this.id = Entity.nextId++;
  }

  public addComponent(name: string, component: Component): void {
    this.components.set(name, component);
    component.setOwner(this);
  }

  public getComponent(name: string): Component | null {
    return this.components.get(name) || null;
  }

  public removeComponent(name: string): void {
    this.components.delete(name);
  }

  public hasComponent(name: string): boolean {
    return this.components.has(name);
  }

  public addChildren(child: Entity): void {
    this.children.push(child);
    child.setParent(this);
  }

  public getChildren(): Entity[] {
    return this.children;
  }

  public setParent(parent: Entity): void {
    this.parent = parent;
  }

  public getParent(): Entity | null {
    return this.parent;
  }

  public getAllComponents(): Component[] {
    return Array.from(this.components.values());
  }

  public getComponentEntries(): [string, Component][] {
    return Array.from(this.components.entries());
  }

  public getName(): string {
    const nameComponent = this.getComponent('name') as NameComponent;
    return nameComponent?.getName() || `Entity_${this.id}`;
  }

  /**
   * Envía un mensaje a esta entidad. Todos los componentes suscritos
   * a ese tipo de mensaje recibirán la llamada (si la entidad los posee).
   *
   * ```ts
   * entity.sendMsg(Msg.damage({ amount: 10, instigator: null }));
   * ```
   */
  public sendMsg(msg: IMsg): void {
    MsgDispatcher.dispatch(this, msg);
  }

  public toString(): string {
    return `Entity(${this.getName()}, id=${this.id})`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _editorFolder: any = null;
  /** Set by pool systems (e.g. BulletPoolComponent) to hide this entity from the editor. */
  public isPoolEntity: boolean = false;
  /**
   * JSON sin parsear con el que se creó (entrada de la escena o spawnFromJSON), para
   * duplicarla desde el editor. null en hijos de glTF/prefab y entidades creadas por código.
   */
  public sourceData: EntityDataType | null = null;

  /** Registered by ModuleEditorSelection: opening the entity's folder selects it. */
  private static _onGuiSelect: ((entity: Entity) => void) | null = null;
  public static registerGuiSelectCallback(cb: (entity: Entity) => void): void {
    Entity._onGuiSelect = cb;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getEditorFolder(): any {
    return this._editorFolder;
  }

  /** Abre su carpeta del F2 (y las de sus padres) y la desplaza a la vista. */
  public revealInEditor(): void {
    if (!this._editorFolder) this.parent?.revealInEditor(); // los hijos se construyen al abrir al padre
    const folder = this._editorFolder;
    if (!folder) return;
    for (let p = folder.parent; p; p = p.parent) p.open();
    folder.open();
    folder.domElement.scrollIntoView({ block: 'nearest' });
  }

  /** Quita su carpeta del F2 (al destruirla). */
  public disposeEditorFolder(): void {
    this._editorFolder?.destroy();
    this._editorFolder = null;
  }

  public renderDebug(filter?: string): void {
    for (const component of this.components.values()) {
      component.renderDebug(filter);
    }
  }

  /** Registered by ModuleEditorSelection to avoid a circular Engine→Entity import. */
  private static _onGuiHover: ((entity: Entity | null) => void) | null = null;
  public static registerGuiHoverCallback(cb: (entity: Entity | null) => void): void {
    Entity._onGuiHover = cb;
  }

  /**
   * Adds this entity as a sub-folder of the provided raw lil-gui folder.
   * Delegates to each component's renderInMenu(entitySubFolder) so each
   * component can add its own controls. Idempotent – safe to call every frame.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public renderInMenu(parentFolder: any): void {
    if (this._editorFolder) return; // already built
    this._editorFolder = parentFolder.addFolder(`${this.getName()} [${this.id}]`);
    this._editorFolder.close();

    // Wireframe on GUI hover — attach to the folder title bar DOM element.
    const titleEl: HTMLElement | undefined = this._editorFolder.$title;
    if (titleEl && Entity._onGuiHover) {
      const self = this;
      titleEl.addEventListener('mouseenter', () => Entity._onGuiHover?.(self));
      titleEl.addEventListener('mouseleave', () => Entity._onGuiHover?.(null));
    }

    // Build the contents lazily on first open: with thousands of entities, eagerly creating
    // every component panel adds tens of thousands of controllers, and each `.listen()` one
    // runs its own requestAnimationFrame loop even inside closed folders.
    const folder = this._editorFolder;
    let built = false;
    folder.onOpenClose((changed: any) => {
      if (changed !== folder || changed._closed) return;
      Entity._onGuiSelect?.(this);
      if (built) return;
      built = true;
      for (const component of this.components.values()) {
        component.renderInEntityPanel(folder);
      }
      for (const child of this.children) {
        child.renderInMenu(folder);
      }
    });
  }
}
