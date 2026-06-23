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
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { PaletteQuantizeComponent } from '../../components/render/PaletteQuantizeComponent';
import { AutoExposureComponent } from '../../components/render/AutoExposureComponent';
import { FSRComponent } from '../../components/render/FSRComponent';
import { NameComponent } from '../../components/core/NameComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { FXAAComponent } from '../../components/render/FXAAComponent';
import { SMAAComponent } from '../../components/render/SMAAComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { RenderComponent } from '../../components/render/RenderComponent';
import { BoxColliderComponent } from '../../components/physics/BoxColliderComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { CameraArmComponent } from '../../components/game/CameraArmComponent';
import { FPSCameraControllerComponent } from '../../components/game/FPSCameraControllerComponent';
import { HeadBobComponent } from '../../components/game/HeadBobComponent';
import { LandingCameraComponent } from '../../components/game/LandingCameraComponent';
import { CameraCrouchComponent } from '../../components/game/CameraCrouchComponent';
import { CameraFOVModifierComponent } from '../../components/game/CameraFOVModifierComponent';
import { InfinitePlaneColliderComponent } from '../../components/physics/InfinitePlaneColliderComponent';
import { MeshColliderComponent } from '../../components/physics/MeshColliderComponent';
import { ParticleSystemComponent } from '../../components/render/ParticleSystemComponent';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { AreaLightComponent } from '../../components/render/AreaLightComponent';
import { DepthOfFieldComponent } from '../../components/render/DepthOfFieldComponent';
import { MotionBlurComponent } from '../../components/render/MotionBlurComponent';
import { SMAAT2xComponent } from '../../components/render/SMAAT2xComponent';
import { TAAComponent } from '../../components/render/TAAComponent';
import { TSRComponent } from '../../components/render/TSRComponent';
import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { HeadTiltComponent } from '../../components/game/HeadTiltComponent';
import { SpeedLinesVFXComponent } from '../../components/vfx/SpeedLinesVFXComponent';
import { TrailRendererComponent } from '../../components/vfx/TrailRendererComponent';
import { ShockwavePostProcessComponent } from '../../components/render/ShockwavePostProcessComponent';
import { FarReachTentacleComponent } from '../../components/vfx/FarReachTentacleComponent';
import { ImpulsePadComponent } from '../../components/game/ImpulsePadComponent';
import { SwingBarComponent } from '../../components/game/SwingBarComponent';
import { SphereColliderComponent } from '../../components/physics/SphereColliderComponent';
import { HeightFogComponent } from '../../components/vfx/HeightFogComponent';
import { AtmosphericFogComponent } from '../../components/vfx/AtmosphericFogComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { ContactShadowsComponent } from '../../components/render/ContactShadowsComponent';
import { GodRaysComponent } from '../../components/render/GodRaysComponent';
import { FogMultiScatterComponent } from '../../components/render/FogMultiScatterComponent';
import { LensFlareComponent } from '../../components/render/LensFlareComponent';
import { ChromaticAberrationComponent } from '../../components/render/ChromaticAberrationComponent';
import { FilmGrainComponent } from '../../components/render/FilmGrainComponent';
import { VignetteComponent } from '../../components/render/VignetteComponent';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { SpiderControllerComponent } from '../../components/game/SpiderControllerComponent';
import { LynxControllerComponent } from '../../components/game/LynxControllerComponent';
import { HackAndSlashControllerComponent } from '../../components/game/HackAndSlashControllerComponent';
import { KickableComponent } from '../../components/game/KickableComponent';
import { KCCMovement } from '../../components/game/movement/KCCMovement';
import { DummyEnemyController } from '../../components/game/DummyEnemyController';
import { BasePlayerController } from '../../components/game/BasePlayerController';
import { PerceptionComponent } from '../../components/game/PerceptionComponent';
import { ProjectileComponent } from '../../components/game/ProjectileComponent';
import { DaggerProjectileComponent } from '../../components/game/combat/DaggerProjectileComponent';
import { SpearProjectileComponent } from '../../components/game/combat/SpearProjectileComponent';
import { GrappleTargetComponent } from '../../components/game/GrappleTargetComponent';
import { ChargeTargetComponent } from '../../components/game/ChargeTargetComponent';
import { BulletPoolComponent } from '../../components/game/BulletPoolComponent';
import { WeaponComponent } from '../../components/game/WeaponComponent';
import { FogVolumeComponent } from '../../components/vfx/FogVolumeComponent';
import { PlayerSpawnComponent } from '../../components/game/PlayerSpawnComponent';
import { HealthComponent } from '../../components/game/HealthComponent';
import { BloodZoneComponent } from '../../components/game/combat/BloodZoneComponent';
import { BloodBallProjectileComponent } from '../../components/game/combat/BloodBallProjectileComponent';
import { BloodExplosiveProjectileComponent } from '../../components/game/combat/BloodExplosiveProjectileComponent';
import { MeleeAttackComponent } from '../../components/game/combat/MeleeAttackComponent';
import { PlayerAttackComponent } from '../../components/game/combat/PlayerAttackComponent';
import { HitReactionComponent } from '../../components/game/HitReactionComponent';
import { MotionMatchRecoveryComponent } from '../../components/game/MotionMatchRecoveryComponent';
import { BoneAttachmentComponent } from '../../components/game/BoneAttachmentComponent';
import { HitStopComponent } from '../../components/game/HitStopComponent';
import { CameraShakeComponent } from '../../components/game/CameraShakeComponent';
import { HomingProjectileComponent } from '../../components/game/combat/HomingProjectileComponent';
import { WeakPointComponent } from '../../components/game/combat/WeakPointComponent';
import { TankMeleeController } from '../../components/game/TankMeleeController';
import { CombatDirectorComponent } from '../../components/game/CombatDirectorComponent';
import { StaminaComponent } from '../../components/game/StaminaComponent';
import { BloodComponent } from '../../components/game/BloodComponent';
import { BloodDrainSourceComponent } from '../../components/game/BloodDrainSourceComponent';
import { SkeletalMeshComponent } from '../../components/render/SkeletalMeshComponent';
import { AnimatorComponent } from '../../components/render/AnimatorComponent';
import { FootIKComponent } from '../../components/render/FootIKComponent';
import { ViewModelComponent } from '../../components/render/ViewModelComponent';
import { ViewModelMeshComponent } from '../../components/render/ViewModelMeshComponent';
import { TerrainComponent } from '../../components/render/TerrainComponent';
import { GrassVolumeComponent } from '../../components/render/GrassVolumeComponent';

type Operation = 'add' | 'multiply';

export class Loader {
  // Contadores para tracking de progreso
  private static totalEntitiesToLoad: number = 0;
  private static entitiesLoaded: number = 0;

  // Contadores para el parsing (GLTFs)
  private static totalGltfsToLoad: number = 0;
  private static gltfsLoaded: number = 0;

  /**
   * Cuenta recursivamente cuántos nodos tienen gltf en el árbol
   */
  private static countGltfs(json: EntityDataType): number {
    let count = json.gltf ? 1 : 0;
    if (json.prefab) count++; // prefab puede tener gltf, cuenta conservadoramente
    const children = json.children ?? [];
    for (const child of children) {
      count += this.countGltfs(child);
    }
    return count;
  }

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

    // Cargar entidades raíz en paralelo, con log por entidad
    await Promise.all(
      json.map(async (e) => {
        await this.loadEntityFromJSON(e);
      }),
    );
  }

  public static async parseSceneJSON(json: SceneDataType): Promise<SceneDataType> {
    // Contar GLTFs antes de empezar para mostrar progreso real
    this.totalGltfsToLoad = 0;
    this.gltfsLoaded = 0;
    for (const e of json) {
      this.totalGltfsToLoad += this.countGltfs(e);
    }

    LoadingStatus.updateStatus(`Parsing scene data... (0/${this.totalGltfsToLoad} assets)`);

    // Procesar todas las entidades en paralelo para acelerar el parsing
    const parsePromises = json.map(async (entityJson) => {
      const result = await this.parseEntityFromJSON(entityJson);
      return result;
    });
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
      json.gltf = prefabJson.gltf;

      json.components = mergedComponents;
    }

    if (json.gltf) {
      const gltfJson = await GLTFLoader.loadGLTF(json.gltf);
      entityChildrens = entityChildrens.concat(gltfJson);
      this.gltfsLoaded++;
      LoadingStatus.updateStatus(
        `Parsing scene data... (${this.gltfsLoaded}/${this.totalGltfsToLoad}) ${json.gltf}`,
      );
    }

    // Load children after parent is fully setup - proceso en paralelo
    const childrenPromises = entityChildrens.map((children_json) =>
      this.parseEntityFromJSON(children_json),
    );
    const parsedEntities = await Promise.all(childrenPromises);
    json.children = parsedEntities;

    return json;
  }

  public static async loadEntityFromJSON(
    json: EntityDataType,
    parent?: Entity,
    trackProgress: boolean = true,
  ): Promise<Entity> {
    const entity = new Entity();

    // Set parent relationship first
    if (parent) {
      parent.addChildren(entity);
    }

    Engine.getEntities().addEntity(entity);

    let entityChildrens = json.children ?? [];

    await this.loadComponentFromJSON(json, entity);

    if (trackProgress) {
      this.entitiesLoaded++;
      LoadingStatus.updateStatus(
        `Loading entities... (${this.entitiesLoaded}/${this.totalEntitiesToLoad})`,
      );
      // Yield to the browser's rendering loop every 8 entities so the progress
      // text is actually visible. Without this, Promise.all drains the entire
      // microtask queue before the browser can repaint — the counter jumps from
      // e.g. 39 to 199 in a single frame because all entities complete as one
      // uninterrupted microtask burst.
      if (this.entitiesLoaded % 8 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // Load children in parallel — safe because Technique/Material/Texture all have
    // inflight dedup maps that prevent duplicate registration under concurrent load.
    await Promise.all(
      entityChildrens.map((children_json) =>
        this.loadEntityFromJSON(children_json, entity, trackProgress),
      ),
    );

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
        // Alias genérico: cualquier BasePlayerController también es localizable
        // con 'player_controller' sin saber qué controlador concreto hay en escena.
        // El update loop usa 'player_controller' (ya está en components.json),
        // así un solo entry cubre todos los controllers futuros.
        const updateKey = comp instanceof BasePlayerController ? 'player_controller' : type;
        if (comp instanceof BasePlayerController) {
          entity.addComponent('player_controller', comp);
        }
        await comp.load(compData);
        Engine.getEntities().addComponentToManager(comp, updateKey);
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
      case 'skeletal_mesh':
        return new SkeletalMeshComponent();
      case 'animator':
        return new AnimatorComponent();
      case 'foot_ik':
        return new FootIKComponent();
      case 'camera':
        return new CameraComponent();
      case 'tone_mapping':
        return new ToneMappingComponent();
      case 'palette_quantize':
        return new PaletteQuantizeComponent();
      case 'auto_exposure':
        return new AutoExposureComponent();
      case 'fsr':
        return new FSRComponent();
      case 'fxaa':
        return new FXAAComponent();
      case 'smaa':
        return new SMAAComponent();
      case 'smaa_t2x':
        return new SMAAT2xComponent();
      case 'taa':
        return new TAAComponent();
      case 'tsr':
        return new TSRComponent();
      case 'chromatic_aberration':
        return new ChromaticAberrationComponent();
      case 'film_grain':
        return new FilmGrainComponent();
      case 'vignette':
        return new VignetteComponent();
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
      case 'area_light':
        return new AreaLightComponent();
      case 'bloom':
        return new BloomComponent();
      case 'box_collider':
        return new BoxColliderComponent();
      case 'capsule_collider':
        return new CapsuleColliderComponent();
      case 'sphere_collider':
        return new SphereColliderComponent();
      case 'character_controller':
      case 'lynx_controller':
        return new LynxControllerComponent();
      case 'hack_and_slash_controller':
      case 'parkour_controller':
        return new HackAndSlashControllerComponent();
      case 'kickable':
        return new KickableComponent();
      case 'kcc_movement':
        return new KCCMovement();
      case 'dummy_enemy_controller':
        return new DummyEnemyController();
      case 'camera_arm':
        return new CameraArmComponent();
      case 'fps_camera_controller':
        return new FPSCameraControllerComponent();
      case 'head_bob':
        return new HeadBobComponent();
      case 'head_tilt':
        return new HeadTiltComponent();
      case 'landing_camera':
        return new LandingCameraComponent();
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
      case 'trail_renderer':
        return new TrailRendererComponent();
      case 'shockwave':
        return new ShockwavePostProcessComponent();
      case 'far_reach_tentacle':
        return new FarReachTentacleComponent();
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
      case 'enemy_controller':
        return new EnemyControllerComponent();
      case 'spider_controller':
        return new SpiderControllerComponent();
      case 'tank_melee_controller':
        return new TankMeleeController();
      case 'combat_director':
        return new CombatDirectorComponent();
      case 'perception':
        return new PerceptionComponent();
      case 'projectile':
        return new ProjectileComponent();
      case 'dagger_projectile':
        return new DaggerProjectileComponent();
      case 'spear_projectile':
        return new SpearProjectileComponent();
      case 'blood_ball_projectile':
        return new BloodBallProjectileComponent();
      case 'blood_explosive_projectile':
        return new BloodExplosiveProjectileComponent();
      case 'melee_attack':
        return new MeleeAttackComponent();
      case 'player_attack':
        return new PlayerAttackComponent();
      case 'hit_reaction':
        return new HitReactionComponent();
      case 'motion_match_recovery':
        return new MotionMatchRecoveryComponent();
      case 'bone_attachment':
        return new BoneAttachmentComponent();
      case 'hit_stop':
        return new HitStopComponent();
      case 'camera_shake':
        return new CameraShakeComponent();
      case 'homing_projectile':
        return new HomingProjectileComponent();
      case 'weak_point':
        return new WeakPointComponent();
      case 'grapple_target':
        return new GrappleTargetComponent();
      case 'charge_target':
        return new ChargeTargetComponent();
      case 'bullet_pool':
        return new BulletPoolComponent();
      case 'weapon':
        return new WeaponComponent();
      case 'height_fog':
        return new HeightFogComponent();
      case 'atmospheric_fog':
        return new AtmosphericFogComponent();
      case 'contact_shadows':
        return new ContactShadowsComponent();
      case 'god_rays':
        return new GodRaysComponent();
      case 'fog_multi_scatter':
        return new FogMultiScatterComponent();
      case 'lens_flare':
        return new LensFlareComponent();
      case 'fog_volume':
        return new FogVolumeComponent();
      case 'player_spawn':
        return new PlayerSpawnComponent();
      case 'health':
        return new HealthComponent();
      case 'blood_zone':
        return new BloodZoneComponent();
      case 'stamina':
        return new StaminaComponent();
      case 'blood':
        return new BloodComponent();
      case 'blood_drain_source':
        return new BloodDrainSourceComponent();
      case 'view_model':
        return new ViewModelComponent();
      case 'view_model_mesh':
        return new ViewModelMeshComponent();
      case 'terrain':
        return new TerrainComponent();
      case 'grass_volume':
        return new GrassVolumeComponent();
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
