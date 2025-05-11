import { NameComponent } from "../../components/core/NameComponent";
import { TransformComponent } from "../../components/core/TransformComponent";
import { CameraComponent } from "../../components/render/CameraComponent";
import { RenderComponent } from "../../components/render/RenderComponent";
import { ToneMappingComponent } from "../../components/render/ToneMappingComponent";
import { SceneDataType, EntityDataType } from "../../types/SceneData.type";
import { Component } from "../ecs/Component";
import { Entity } from "../ecs/Entity";
import { Engine } from "../engine/Engine";


export class Loader {
  public static async loadSceneFromJSON(json: SceneDataType): Promise<void> {
    for (const e of json) {
      await this.loadEntityFromJSON(e);
    }
  }

  public static async loadEntityFromJSON(json: EntityDataType, parent?: Entity): Promise<Entity> {
    const entity = new Entity();
    
    // Set parent relationship first
    if(parent) {
      parent.addChildren(entity);
    }

    Engine.getEntities().addEntity(entity);
    await this.loadComponentFromJSON(json, entity);

    // Load children after parent is fully setup
    for (const children_json of json.children || []) {
      await this.loadEntityFromJSON(children_json, entity);
    }

    return entity;
  }

  public static async loadComponentFromJSON(json: EntityDataType, entity: Entity): Promise<void> {
    // Cargar primero el componente name para que los logs tengan el nombre correcto
    if (json.components.name) {
      const nameComp = this.createComponentFromJSON('name');
      entity.addComponent('name', nameComp);
      await nameComp.load(json.components.name);
      Engine.getEntities().addComponentToManager(nameComp, 'name');
    }

    // Luego cargar el resto de componentes
    for (const [type, compData] of Object.entries(json.components)) {
      if (type === 'name') continue; // Ya cargado
      const comp = this.createComponentFromJSON(type);
      entity.addComponent(type, comp);
      await comp.load(compData);
      Engine.getEntities().addComponentToManager(comp, type);
    }
  }

  public static createComponentFromJSON(type: string): Component {
    switch (type) {
      case 'name':
        return new NameComponent();
        break;
      case 'transform':
        return new TransformComponent();
        break;
      case 'render':
        return new RenderComponent();
        break;
      case 'camera':
        return new CameraComponent();
        break;
      case 'tone_mapping':
        return new ToneMappingComponent();
        break;
      /*case 'autoAlignedBoundingBox':
        entity.addComponent(type, new AABBComponent());
        break;
      case 'light':
        entity.addComponent(type, new LightComponent(compData));
        break;*/
      default:
        throw new Error(`Unknown component type: ${type}`);
    }
  }
}