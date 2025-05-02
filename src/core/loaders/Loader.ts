import { NameComponent } from "../../components/core/NameComponent";
import { TransformComponent } from "../../components/core/TransformComponent";
import { RenderComponent } from "../../components/render/RenderComponent";
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

  public static async loadEntityFromJSON(json: EntityDataType): Promise<Entity> {
    const entity = new Entity();

    Engine.getEntities().addEntity(entity);
    await this.loadComponentFromJSON(json, entity);

    for (const children_json of json.children || []) {
      const children = await this.loadEntityFromJSON(children_json);
      entity.addChildren(children);
    }

    return entity;
  }

  public static async loadComponentFromJSON(json: EntityDataType, entity: Entity): Promise<void> {
    for (const [type, compData] of Object.entries(json.components)) {
      const comp = this.createComponentFromJSON(type);
      entity.addComponent(type, comp);
      await comp.load(compData);
      Engine.getEntities().addComponentToManager(comp, type);
    }
  }

  public static createComponentFromJSON(type: string): Component {
    switch (type) {
      case 'transform':
        return new TransformComponent();
        break;
      case 'render':
        return new RenderComponent();
        break;
      case 'name':
        return new NameComponent();
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