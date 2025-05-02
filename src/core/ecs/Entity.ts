import { Component } from "./Component";

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

    public setParent(parent: Entity): void {
      this.parent = parent;
    }
  }