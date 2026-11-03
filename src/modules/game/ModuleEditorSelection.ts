import { vec3 } from 'gl-matrix';
import { Module } from '../core/Module';
import { ModuleEntities } from '../core/ModuleEntities';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { Loader } from '../../core/loaders/Loader';
import { Logger } from '../../core/debug/Logger';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';
import { CameraComponent } from '../../components/render/CameraComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { screenPointToRay } from '../../core/math/ScreenRay';
import { MouseButton } from '../../types/MouseButton.enum';
import { KeyCode } from '../../types/KeyCode.enum';
import { EntityDataType } from '../../types/SceneData.type';
import { fetchEditorList } from './EditorToolbar';

/** Distancia del spawn delante de la cámara si el rayo no toca nada. */
const SPAWN_DISTANCE = 5;

export class ModuleEditorSelection extends Module {
  private selectedEntity: Entity | null = null;
  private guiHoveredEntity: Entity | null = null;
  /** El último mousedown fue fuera del canvas (sobre el panel): no selecciona en el mundo. */
  private mouseDownOutsideCanvas = false;
  /** Abriendo carpetas para mostrar la selección: sus callbacks no cambian la selección. */
  private revealing = false;
  private filterText = '';
  private readonly onMouseDown = (e: MouseEvent): void => {
    this.mouseDownOutsideCanvas = !(e.target instanceof HTMLCanvasElement);
  };

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    Entity.registerGuiHoverCallback((entity) => this.setGuiHoveredEntity(entity));
    Entity.registerGuiSelectCallback((entity) => {
      if (!this.revealing) this.setSelectedEntity(entity, false);
    });
    ModuleEntities.setSceneTools((folder) => this.buildSceneTools(folder));
    window.addEventListener('mousedown', this.onMouseDown, true);
    return true;
  }

  public stop(): void {
    window.removeEventListener('mousedown', this.onMouseDown, true);
    this.setSelectedEntity(null);
    this.guiHoveredEntity = null;
  }

  public update(_dt: number): void {
    const input = Engine.getInput();
    if (input.isMouseButtonJustPressed(MouseButton.LEFT) && !this.mouseDownOutsideCanvas) {
      this.performSelection();
    }
    if (input.isKeyJustPressed(KeyCode.DELETE) && !this.isTyping()) {
      this.deleteSelected();
    }
  }

  public override pushDebugLines(_filter?: string): void {
    const physicsDebug = PhysicsDebugDrawer.getInstance();

    // GUI hover (blue) — routed through component system so each component uses its own color
    if (this.guiHoveredEntity) {
      this.guiHoveredEntity.renderDebug('all');
    }

    // Selected entity (bright red)
    if (this.selectedEntity) {
      physicsDebug.addMeshWireframe(this.selectedEntity, [10.0, 0.0, 0.0, 1.0]);
    }
  }

  public override renderDebug(_filter?: string): void {}

  public override renderInMenu(): void {}

  public getSelectedEntity(): Entity | null {
    return this.selectedEntity;
  }

  /** Selecciona (o null) y la resalta en el F2; `reveal` abre su carpeta y la desplaza a la vista. */
  public setSelectedEntity(entity: Entity | null, reveal = true): void {
    if (entity === this.selectedEntity) return;
    this.highlight(this.selectedEntity, false);
    this.selectedEntity = entity;
    if (!entity) return;
    if (reveal) {
      this.revealing = true;
      entity.revealInEditor();
      this.revealing = false;
    }
    this.highlight(entity, true);
  }

  /** Título de su carpeta en rojo (inline: las reglas por nivel del tema usan !important). */
  private highlight(entity: Entity | null, on: boolean): void {
    const title: HTMLElement | undefined = entity?.getEditorFolder()?.$title;
    if (!title) return;
    if (on) {
      title.style.setProperty('color', '#ff7a6b', 'important');
      title.style.setProperty('background', '#2a1715', 'important');
    } else {
      title.style.removeProperty('color');
      title.style.removeProperty('background');
    }
  }

  public setGuiHoveredEntity(entity: Entity | null): void {
    this.guiHoveredEntity = entity;
  }

  private performSelection(): void {
    const camera = this.getEditorCamera();
    if (!camera) return;

    const mousePos = Engine.getInput().getMousePosition();
    const ray = screenPointToRay(mousePos.x, mousePos.y, camera.getCamera());

    const result = Engine.getPhysics().raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);

    if (result) {
      const entity = Engine.getEntities().getEntityById(result.entityId);
      // Toggle off if same entity clicked again
      this.setSelectedEntity(entity && entity !== this.selectedEntity ? entity : null);
    } else {
      this.setSelectedEntity(null);
    }
  }

  private getEditorCamera(): CameraComponent | null {
    const debugCamera = Engine.getEntities().getEntityByName('DebugCamera');
    if (!debugCamera) return null;
    return debugCamera.getComponent('camera') as CameraComponent;
  }

  private isTyping(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scene tools (arriba de la carpeta Scene del F2)
  // ─────────────────────────────────────────────────────────────────────────────

  private buildSceneTools(folder: any): void {
    const tools = folder.addFolder('Tools');
    tools.open();

    const state = { filter: '', prefab: '', selected: '' };
    Object.defineProperty(state, 'selected', {
      get: () => this.selectedEntity?.getName() ?? '—',
      enumerable: true,
    });
    tools
      .add(state, 'filter')
      .name('Filter')
      .onChange((v: string) => {
        this.filterText = v.trim().toLowerCase();
        this.applyFilter();
      });
    tools.add(state, 'selected').name('Selected').disable().listen();
    tools.add({ fn: () => this.duplicateSelected() }, 'fn').name('Duplicate');
    tools.add({ fn: () => this.deleteSelected() }, 'fn').name('Delete (Supr)');

    // Spawn: el desplegable se rellena cuando llega la lista del servidor de desarrollo.
    void fetchEditorList('prefabs').then((prefabs) => {
      if (!prefabs.length) return;
      state.prefab = prefabs[0]!;
      tools.add(state, 'prefab', prefabs).name('Prefab');
      tools.add({ fn: () => void this.spawnPrefab(state.prefab) }, 'fn').name('Spawn prefab');
    });
  }

  /** Oculta las entidades raíz cuyo nombre no contiene el filtro. */
  private applyFilter(): void {
    for (const entity of Engine.getEntities().getAllEntities()) {
      if (entity.getParent()) continue;
      const folder = entity.getEditorFolder();
      if (!folder) continue;
      const match = !this.filterText || entity.getName().toLowerCase().includes(this.filterText);
      folder.show(match);
    }
  }

  /** Crea el prefab donde mira la cámara del editor (lo que toque el rayo, o a 5 m). */
  private async spawnPrefab(prefab: string): Promise<void> {
    const camera = this.getEditorCamera()?.getCamera();
    if (!camera) return;
    const origin = vec3.clone(camera.getPosition());
    const dir = vec3.normalize(vec3.create(), camera.getFront());
    const hit = Engine.getPhysics().raycastClosestNonSensor(origin, dir, 100.0);
    const distance = hit ? hit.hit.timeOfImpact : SPAWN_DISTANCE;
    const position = vec3.scaleAndAdd(vec3.create(), origin, dir, distance);

    const json: EntityDataType = {
      prefab,
      components: { transform: { position: [position[0]!, position[1]!, position[2]!] } },
    } as EntityDataType;
    try {
      const entity = await Loader.spawnFromJSON(json);
      this.addToPanel(entity);
      Logger.info('ENGINE', `Spawned ${prefab}`);
    } catch (e) {
      Logger.error('ENGINE', `Spawn ${prefab} failed: ${e}`);
    }
  }

  /** Copia de la seleccionada (su JSON de origen con el transform actual), 1 m a un lado. */
  private async duplicateSelected(): Promise<void> {
    const entity = this.selectedEntity;
    if (!entity) return;
    if (!entity.sourceData) {
      Logger.warn('ENGINE', `${entity.getName()}: sin JSON de origen (hijo de glTF/prefab o creada por código)`);
      return;
    }
    const json = structuredClone(entity.sourceData) as { components?: Record<string, any> };
    const transform = (entity.getComponent('transform') as TransformComponent | null)?.getTransform();
    if (transform) {
      const p = transform.getLocalPosition();
      const q = transform.getLocalRotation();
      const s = transform.getLocalScale();
      json.components ??= {};
      const data: Record<string, unknown> = { ...(json.components.transform ?? {}) };
      delete data.rotation; // rotation tiene prioridad sobre quaternion al cargar
      delete data.matrix;
      data.position = [p[0]! + 1, p[1]!, p[2]!];
      data.quaternion = [q[0]!, q[1]!, q[2]!, q[3]!];
      data.scale = [s[0]!, s[1]!, s[2]!];
      json.components.transform = data;
    }
    json.components ??= {};
    json.components.name = `${entity.getName()} copy`; // también sobre el nombre del prefab
    try {
      const copy = await Loader.spawnFromJSON(json as EntityDataType, entity.getParent() ?? undefined);
      this.addToPanel(copy);
    } catch (e) {
      Logger.error('ENGINE', `Duplicate ${entity.getName()} failed: ${e}`);
    }
  }

  private deleteSelected(): void {
    const entity = this.selectedEntity;
    if (!entity) return;
    if (entity.hasComponent('camera')) {
      Logger.warn('ENGINE', `${entity.getName()}: las cámaras no se borran desde el editor`);
      return;
    }
    this.setSelectedEntity(null);
    Engine.getEntities().destroyEntity(entity);
    Logger.info('ENGINE', `Deleted ${entity.getName()}`);
  }

  /** Da carpeta en el F2 a una entidad nueva y la selecciona. */
  private addToPanel(entity: Entity): void {
    const parentFolder = entity.getParent()?.getEditorFolder() ?? Engine.getGUI().getFolder('Scene');
    if (parentFolder) entity.renderInMenu(parentFolder);
    this.applyFilter();
    this.setSelectedEntity(entity);
  }
}
