
import { Component } from "../../core/ecs/Component";
import { Entity } from "../../core/ecs/Entity";
import { ComponentDataType } from "../../types/ComponentData.type";
import { Module } from "../core/Module";

class ObjectManager {
  private list: Component[] = [];
  private name: string = "";

  constructor(name: string) {
    this.name = name
  }

  public getName(): string {
    return this.name;
  }

  public addComponent(component: Component): void {
    this.list.push(component);
  }

  public updateAll(delta: number): void {
    for (const c of this.list) {
      c.update(delta);
    }
  }
  public renderDebugAll(): void {
    for (const c of this.list) {
      c.renderDebug();
    }
  }
}

export class ModuleEntities extends Module {
  private omEntities: Entity[] = [];
  private omToUpdate: Map<string, ObjectManager> = new Map();
  private omToRenderDebug: Map<string, ObjectManager> = new Map();

  constructor(name: string) {
    super(name);
  }

  private loadListOfManagers(json: ComponentDataType): void {
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
    const response = await fetch('/data/components.json');
    const jsonData = await response.json();

    this.loadListOfManagers(jsonData);

    return true;
  }

  public update(delta: number): void {
    for (const [, om] of this.omToUpdate) {
      om.updateAll(delta);
    }
  }

  public renderInMenu(): void {

  }

  public renderDebug(): void {
    this.renderDebugOfComponents();
  }

  private renderDebugOfComponents(): void {
    for (const [, om] of this.omToRenderDebug) {
      om.renderDebugAll();
    }
  }

  public addEntity(entity: Entity): void {
    this.omEntities.push(entity);
  }

  public addComponentToManager(component: Component, managerName: string): void {
    this.omToUpdate.get(managerName)?.addComponent(component);
  }

  public getEntityByName(name: string): Entity | null {
    for (const entity of this.omEntities) {
      if (entity.getName() === name) {
        return entity;
      }
    }
    return null;
    console.log(`Entity with name ${name} not found`);
  }

  public stop(): void {
    throw new Error("Method not implemented.");
  }
}