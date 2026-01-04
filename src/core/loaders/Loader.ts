import { vec3 } from 'gl-matrix';
import { Component } from '../ecs/Component';
import { Entity } from '../ecs/Entity';
import { Engine } from '../engine/Engine';
import { ResourceManager } from '../engine/ResourceManager';
import { LoadingStatus } from '../engine/LoadingStatus';
import { GLTFLoader } from './GLTFLoader';

import { SceneDataType, EntityDataType } from '../../types/SceneData.type';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';

import { AmbientOcclusionComponent } from '../../components/render/AmbientOcclusionComponent';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { NameComponent } from '../../components/core/NameComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { FXAAComponent } from '../../components/render/FXAAComponent';
import { SMAAComponent } from '../../components/render/SMAAComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { RenderComponent } from '../../components/render/RenderComponent';
import { BoxColliderComponent } from '../../components/physics/BoxColliderComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { CharacterControllerComponent } from '../../components/game/CharacterControllerComponent';
import { CameraArmComponent } from '../../components/game/CameraArmComponent';
import { FPSCameraControllerComponent } from '../../components/game/FPSCameraControllerComponent';
import { HeadBobComponent } from '../../components/game/HeadBobComponent';
import { CameraCrouchComponent } from '../../components/game/CameraCrouchComponent';
import { CameraFOVModifierComponent } from '../../components/game/CameraFOVModifierComponent';
import { InfinitePlaneColliderComponent } from '../../components/physics/InfinitePlaneColliderComponent';
import { MeshColliderComponent } from '../../components/physics/MeshColliderComponent';
import { ParticleSystemComponent } from '../../components/render/ParticleSystemComponent';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { DepthOfFieldComponent } from '../../components/render/DepthOfFieldComponent';
import { MotionBlurComponent } from '../../components/render/MotionBlurComponent';
import { SMAAT2xComponent } from '../../components/render/SMAAT2xComponent';
import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { HeadTiltComponent } from '../../components/game/HeadTiltComponent';
import { SpeedLinesVFXComponent } from '../../components/vfx/SpeedLinesVFXComponent';
import { ImpulsePadComponent } from '../../components/game/ImpulsePadComponent';
import { SwingBarComponent } from '../../components/game/SwingBarComponent';

type Operation = 'add' | 'multiply';

export class Loader {
  // Contadores para tracking de progreso
  private static totalEntitiesToLoad: number = 0;
  private static entitiesLoaded: number = 0;

  /**
   * Cuenta recursivamente todas las entidades que se van a cargar
   */
  private static countEntities(json: EntityDataType): number {
    let count = 1; // La entidad actual
    const children = json.children ?? [];
    for (const child of children) {
      count += this.countEntities(child);
    }
    return count;
  }

  public static async loadSceneFromJSON(json: SceneDataType): Promise<void> {
    // Contar todas las entidades antes de empezar
    this.totalEntitiesToLoad = 0;
    this.entitiesLoaded = 0;

    for (const e of json) {
      this.totalEntitiesToLoad += this.countEntities(e);
    }

    // Cargar entidades con progreso
    for (const e of json) {
      await this.loadEntityFromJSON(e);
    }
  }

  public static async parseSceneJSON(json: SceneDataType): Promise<SceneDataType> {
    // Procesar todas las entidades en paralelo para acelerar el parsing
    const parsePromises = json.map((entityJson) => this.parseEntityFromJSON(entityJson));
    const parsedEntities = await Promise.all(parsePromises);
    return parsedEntities;
  }

  public static async parseEntityFromJSON(json: EntityDataType): Promise<EntityDataType> {
    let entityChildrens = json.children ?? [];

    if (json.prefab) {
      const prefabJson = await ResourceManager.loadPrefab(json.prefab);
      if (prefabJson.children) {
        entityChildrens = entityChildrens.concat(prefabJson.children);
      }

      if (json.components) {
        if (json.components.name && prefabJson.components.name !== undefined) {
          json.components.name += prefabJson.components.name;
          delete prefabJson.components.name;
        }
        if (json.components.transform && prefabJson.components.transform) {
          json.components.transform = this.combineTransforms(
            json.components.transform,
            prefabJson.components.transform,
          );
          delete prefabJson.components.transform;
        }
      }

      const mergedComponents = {
        ...json.components,
        ...prefabJson.components,
      };

      json.components = mergedComponents;
    }

    if (json.gltf) {
      const gltfJson = await GLTFLoader.loadGLTF(json.gltf);
      entityChildrens = entityChildrens.concat(gltfJson);
    }

    // Load children after parent is fully setup - proceso en paralelo
    const childrenPromises = entityChildrens.map((children_json) =>
      this.parseEntityFromJSON(children_json),
    );
    const parsedEntities = await Promise.all(childrenPromises);
    json.children = parsedEntities;

    return json;
  }

  public static async loadEntityFromJSON(json: EntityDataType, parent?: Entity): Promise<Entity> {
    const entity = new Entity();

    // Set parent relationship first
    if (parent) {
      parent.addChildren(entity);
    }

    Engine.getEntities().addEntity(entity);

    let entityChildrens = json.children ?? [];

    await this.loadComponentFromJSON(json, entity);

    // Incrementar contador y actualizar progreso
    this.entitiesLoaded++;
    const progress = this.entitiesLoaded / this.totalEntitiesToLoad;
    const entityName = json.components?.name || `Entity ${this.entitiesLoaded}`;

    // Actualizar solo el mensaje, mantener el progreso del módulo Boot
    LoadingStatus.updateStatus(
      `Loading entities... (${this.entitiesLoaded}/${this.totalEntitiesToLoad})`,
    );

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
      nameComp.load(json.components.name);
      Engine.getEntities().addComponentToManager(nameComp, 'name');
    }

    // Preparar todos los componentes en paralelo (creación + carga)
    const componentPromises: Promise<{ type: string; comp: Component }>[] = [];

    for (const [type, compData] of Object.entries(json.components)) {
      if (type === 'name') continue; // Ya cargado

      // Crear y cargar componentes en paralelo
      const promise = (async () => {
        const comp = this.createComponentFromJSON(type);
        entity.addComponent(type, comp);
        await comp.load(compData);
        Engine.getEntities().addComponentToManager(comp, type);
        return { type, comp };
      })();

      componentPromises.push(promise);
    }

    // Esperar a que todos los componentes se carguen
    const loadedComponents = await Promise.all(componentPromises);

    // Llamar a onAttach() después de que todos los componentes estén cargados
    // Esto permite que los componentes puedan obtener referencias a otros componentes
    const attachPromises = loadedComponents.map(({ comp }) => comp.onAttach());
    await Promise.all(attachPromises);
  }

  public static createComponentFromJSON(type: string): Component {
    switch (type) {
      case 'name':
        return new NameComponent();
      case 'transform':
        return new TransformComponent();
      case 'render':
        return new RenderComponent();
      case 'camera':
        return new CameraComponent();
      case 'tone_mapping':
        return new ToneMappingComponent();
      case 'fxaa':
        return new FXAAComponent();
      case 'smaa':
        return new SMAAComponent();
      case 'smaa_t2x':
        return new SMAAT2xComponent();
      case 'reflection_probe':
        return new ReflectionProbeComponent();
      case 'ambient_occlusion':
        return new AmbientOcclusionComponent();
      case 'point_light':
        return new PointLightComponent();
      case 'spot_light':
        return new SpotLightComponent();
      case 'directional_light':
        return new DirectionalLightComponent();
      case 'bloom':
        return new BloomComponent();
      case 'box_collider':
        return new BoxColliderComponent();
      case 'capsule_collider':
        return new CapsuleColliderComponent();
      case 'character_controller':
        return new CharacterControllerComponent();
      case 'camera_arm':
        return new CameraArmComponent();
      case 'fps_camera_controller':
        return new FPSCameraControllerComponent();
      case 'head_bob':
        return new HeadBobComponent();
      case 'head_tilt':
        return new HeadTiltComponent();
      case 'camera_crouch':
        return new CameraCrouchComponent();
      case 'camera_fov_modifier':
        return new CameraFOVModifierComponent();
      case 'infinite_plane_collider':
        return new InfinitePlaneColliderComponent();
      case 'mesh_collider':
        return new MeshColliderComponent();
      case 'particle_system':
        return new ParticleSystemComponent();
      case 'depth_of_field':
        return new DepthOfFieldComponent();
      case 'motion_blur':
        return new MotionBlurComponent();
      case 'speed_lines_vfx':
        return new SpeedLinesVFXComponent();
      case 'impulse_pad':
        return new ImpulsePadComponent();
      case 'swing_bar':
        return new SwingBarComponent();
      default:
        throw new Error(`Unknown component type: ${type}`);
    }
  }

  private static combineTransforms(
    transformA: TransformComponentDataType,
    transformB: TransformComponentDataType,
  ): TransformComponentDataType {
    return {
      position: this.combineArray(transformA?.position, transformB?.position, 'add'),
      rotation: this.combineArray(transformA?.rotation, transformB?.rotation, 'add'),
      scale: this.combineArray(transformA?.scale, transformB?.scale, 'multiply'),
    };
  }

  private static combineArray(
    arr1: vec3 | undefined,
    arr2: vec3 | undefined,
    operation: Operation,
  ): vec3 {
    const defaultVal = operation === 'multiply' ? 1 : 0;
    const val1 = arr1?.[0] ?? defaultVal;
    const val2 = arr2?.[0] ?? defaultVal;
    const val3 = arr1?.[1] ?? defaultVal;
    const val4 = arr2?.[1] ?? defaultVal;
    const val5 = arr1?.[2] ?? defaultVal;
    const val6 = arr2?.[2] ?? defaultVal;

    return vec3.fromValues(
      operation === 'add' ? val1 + val2 : val1 * val2,
      operation === 'add' ? val3 + val4 : val3 * val4,
      operation === 'add' ? val5 + val6 : val5 * val6,
    );
  }
}
