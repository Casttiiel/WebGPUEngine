import { NameComponent } from '../../components/core/NameComponent';
import { Component } from './Component';
import { MsgDispatcher } from './MsgDispatcher';
import type { IMsg } from './Msg';

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

    for (const component of this.components.values()) {
      component.renderInEntityPanel(this._editorFolder);
    }

    for (const child of this.children) {
      child.renderInMenu(this._editorFolder);
    }
  }
}
