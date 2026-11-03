import { ResourceManager } from '../../core/engine/ResourceManager';
import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { ComponentDataType } from '../../types/ComponentData.type';
import { Module } from '../core/Module';
import { Profiler } from '../../core/debug/Profiler';
import { Engine } from '../../core/engine/Engine';

class ObjectManager {
  private list: Component[] = [];
  private name: string = '';

  constructor(name: string) {
    this.name = name;
  }

  public getName(): string {
    return this.name;
  }

  public addComponent(component: Component): void {
    this.list.push(component);
  }

  public updateAll(delta: number): void {
    for (const c of this.list) {
      if (!c.enabled) continue;
      c.update(delta);
    }
  }
  public renderDebugAll(): void {
    for (const c of this.list) {
      c.renderDebug();
    }
  }
  public getList(): Component[] {
    return this.list;
  }

  public removeByOwner(entity: Entity): void {
    this.list = this.list.filter((c) => c.getOwner() !== entity);
  }
}

export class ModuleEntities extends Module {
  private omEntities: Entity[] = [];
  private omToUpdate: Map<string, ObjectManager> = new Map();
  private omToRenderDebug: Map<string, ObjectManager> = new Map();
  private omGeneral: Map<string, ObjectManager> = new Map();
  private debugControlsAdded = false;

  private debugValues = {
    numberEntities: { name: '# Entities', value: 0 },
  };

  constructor(name: string) {
    super(name);
  }

  private loadListOfManagers(json: ComponentDataType): void {
    this.omGeneral = new Map();

    this.omToUpdate = new Map();
    const update_names = json.update;
    for (const n of update_names) {
      const om = new ObjectManager(n);
      this.omToUpdate.set(n, om);
    }

    this.omToRenderDebug = new Map();
    const debug_names = json.render_debug;
    for (const n of debug_names) {
      const om = new ObjectManager(n);
      this.omToRenderDebug.set(n, om);
    }
  }

  public async start(): Promise<boolean> {
    const response = await ResourceManager.fetch(`data/components.json`);
    const jsonData = await response.json();

    this.loadListOfManagers(jsonData);

    return true;
  }

  public update(delta: number): void {
    if (delta <= 0) return;
    Profiler.getInstance().cpu.begin('Entities');
    for (const om of this.omToUpdate.values()) {
      om.updateAll(delta);
    }
    Profiler.getInstance().cpu.end();

    this.debugValues.numberEntities.value = this.omEntities.length;
  }

  /** Editor tools at the top of the Scene folder (registered by ModuleEditorSelection). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static sceneTools: ((folder: any) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static setSceneTools(build: (folder: any) => void): void {
    ModuleEntities.sceneTools = build;
  }

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    const created = gui.beginWindow('Scene');
    const sceneFolder = gui.getFolder('Scene');
    if (!sceneFolder) return;
    if (created) ModuleEntities.sceneTools?.(sceneFolder);

    for (const entity of this.omEntities) {
      if (entity.isPoolEntity || entity.getParent()) continue; // los hijos, dentro de su padre
      entity.renderInMenu(sceneFolder);
    }
  }

  public override pushDebugLines(filter?: string): void {
    if (!filter) return;
    for (const entity of this.omEntities) {
      entity.renderDebug(filter);
    }
  }

  public override renderDebug(_filter?: string): void {}

  public addEntity(entity: Entity): void {
    this.omEntities.push(entity);
  }

  public addComponentToManager(component: Component, managerName: string): void {
    const om = this.omGeneral.get(managerName);
    if (!om) {
      const newOm = new ObjectManager(managerName);
      this.omGeneral.set(managerName, newOm);
    }

    this.omGeneral.get(managerName)?.addComponent(component);
    this.omToUpdate.get(managerName)?.addComponent(component);
  }

  public getObjectManagerByName(name: string): ObjectManager | undefined {
    return this.omGeneral.get(name);
  }

  public getEntityByName(name: string): Entity | null {
    for (const entity of this.omEntities) {
      if (entity.getName() === name) {
        return entity;
      }
    }
    return null;
  }

  public getEntityById(id: number): Entity | null {
    for (const entity of this.omEntities) {
      if (entity.id === id) {
        return entity;
      }
    }
    return null;
  }

  public getAllEntities(): Entity[] {
    return this.omEntities;
  }

  public destroyEntity(entity: Entity): void {
    for (const child of [...entity.getChildren()]) {
      this.destroyEntity(child);
    }
    const siblings = entity.getParent()?.getChildren();
    const at = siblings?.indexOf(entity) ?? -1;
    if (at !== -1) siblings!.splice(at, 1);

    for (const [, om] of this.omGeneral) om.removeByOwner(entity);
    for (const [, om] of this.omToUpdate) om.removeByOwner(entity);
    for (const [, om] of this.omToRenderDebug) om.removeByOwner(entity);

    for (const component of entity.getAllComponents()) {
      component.dispose();
    }
    entity.disposeEditorFolder();

    const idx = this.omEntities.indexOf(entity);
    if (idx !== -1) this.omEntities.splice(idx, 1);
  }

  public stop(): void {
    // Clean up Scene GUI folder
    Engine.getGUI().clearWindow('Scene');

    // Clear entities array (entities will be recreated on restart)
    this.omEntities = [];
    this.omToUpdate = new Map();
    this.omToRenderDebug = new Map();
    this.omGeneral = new Map();
    this.debugControlsAdded = false;

    console.log('ModuleEntities stopped and entities cleared.');
  }
}
