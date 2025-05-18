import { vec3 } from "gl-matrix";
import { NameComponent } from "../../components/core/NameComponent";
import { TransformComponent } from "../../components/core/TransformComponent";
import { AntialiasingComponent } from "../../components/render/AntialiasingComponent";
import { CameraComponent } from "../../components/render/CameraComponent";
import { RenderComponent } from "../../components/render/RenderComponent";
import { ToneMappingComponent } from "../../components/render/ToneMappingComponent";
import { SceneDataType, EntityDataType } from "../../types/SceneData.type";
import { TransformComponentDataType } from "../../types/TransformComponentData.type";
import { Component } from "../ecs/Component";
import { Entity } from "../ecs/Entity";
import { Engine } from "../engine/Engine";
import { ResourceManager } from "../engine/ResourceManager";

type Operation = "add" | "multiply";

export class Loader {
  public static async loadSceneFromJSON(json: SceneDataType): Promise<void> {
    for (const e of json) {
      await this.loadEntityFromJSON(e);
    }
  }

  public static async loadEntityFromJSON(json: EntityDataType, parent?: Entity): Promise<Entity> {
    const entity = new Entity();

    // Set parent relationship first
    if (parent) {
      parent.addChildren(entity);
    }

    Engine.getEntities().addEntity(entity);

    const entityChildrens = json.children ?? [];

    if (json.prefab) {
      const prefabJson = await ResourceManager.loadPrefab(json.prefab);
      if (prefabJson.children) {
        entityChildrens.concat(prefabJson.children);
      }

      const mergedComponents = {
        ...json.components, ...prefabJson.components
      }

      if (json.components) {
        if (json.components.name) {
          mergedComponents.name = prefabJson.components.name;
        }
        if (json.components.transform && prefabJson.components.transform) {
          mergedComponents.transform = this.combineTransforms(json.components.transform, prefabJson.components.transform)
        }
      }

      json.components = mergedComponents;
    }

    await this.loadComponentFromJSON(json, entity);

    // Load children after parent is fully setup
    for (const children_json of entityChildrens) {
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
      case 'antialiasing':
        return new AntialiasingComponent();
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

  private static combineTransforms(transformA: TransformComponentDataType, transformB: TransformComponentDataType): TransformComponentDataType {
    return {
      position: this.combineArray(transformA?.position, transformB?.position, "add"),
      rotation: this.combineArray(transformA?.rotation, transformB?.rotation, "add"),
      scale: this.combineArray(transformA?.scale, transformB?.scale, "multiply"),
    }
  }

  private static combineArray(
    arr1: vec3 | undefined,
    arr2: vec3 | undefined,
    operation: Operation
  ): vec3 {
    const defaultVal = operation === "multiply" ? 1 : 0;
    const val1 = arr1?.[0] ?? defaultVal;
    const val2 = arr2?.[0] ?? defaultVal;
    const val3 = arr1?.[1] ?? defaultVal;
    const val4 = arr2?.[1] ?? defaultVal;
    const val5 = arr1?.[2] ?? defaultVal;
    const val6 = arr2?.[2] ?? defaultVal;

    return vec3.fromValues(operation === "add" ? val1 + val2 : val1 * val2, operation === "add" ? val3 + val4 : val3 * val4, operation === "add" ? val5 + val6 : val5 * val6);
  }
}