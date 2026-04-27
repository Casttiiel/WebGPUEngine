import { NameComponent } from '../../components/core/NameComponent';
import { Component } from './Component';
import { Engine } from '../../core/engine/Engine';
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

  public renderInMenu(parentFolder: string = 'entities'): void {
    // Get Engine instance and ModuleManager
    const moduleManager = Engine.getModules();
    if (!moduleManager) return;

    // Create a subfolder for this entity within the parent folder
    // Use the entity's name as the display title and a unique key based on ID
    const entityName = this.getName();
    const entityKey = `entity_${this.id}`;
    const folderKey = `${parentFolder}_${entityKey}`;

    // Create an entity subfolder with its name (collapsed by default)
    const debugUI = Engine.getDebugUI();
    const entityFolder = debugUI.addSubFolder(
      parentFolder, // Parent folder name
      entityKey, // Subfolder key
      entityName, // Display title
      false, // Start collapsed
    );

    if (!entityFolder) return;

    // Now add controls for each component
    this.components.forEach((component, componentName) => {
      // Add component type info to the entity folder
      debugUI.addControlToSubFolder(
        parentFolder,
        entityKey,
        { type: componentName },
        'type',
        `Component: ${componentName}`,
      );

      // Let the component add its own controls if it implements renderInMenu
      if (typeof component.renderInMenu === 'function') {
        component.renderInMenu();
      }
    });

    // Render all child entities as direct subfolders of this entity
    if (this.children.length > 0) {
      // For each child entity, create its own subfolder under the current entity's folder
      for (const child of this.children) {
        // Pass the current entity's folder key as the parent folder for the child
        child.renderInMenu(folderKey);
      }
    }
  }
}
