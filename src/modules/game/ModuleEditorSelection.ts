import { Module } from '../core/Module';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';
import { CameraComponent } from '../../components/render/CameraComponent';
import { vec3, mat4, vec4 } from 'gl-matrix';
import { MouseButton } from '../../types/MouseButton.enum';

export class ModuleEditorSelection extends Module {
  private selectedEntity: Entity | null = null;
  private guiHoveredEntity: Entity | null = null;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    Entity.registerGuiHoverCallback((entity) => this.setGuiHoveredEntity(entity));
    return true;
  }

  public stop(): void {
    this.selectedEntity = null;
    this.guiHoveredEntity = null;
  }

  public update(_dt: number): void {
    const input = Engine.getInput();
    if (input.isMouseButtonJustPressed(MouseButton.LEFT)) {
      this.performSelection();
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

  public setGuiHoveredEntity(entity: Entity | null): void {
    this.guiHoveredEntity = entity;
  }

  private performSelection(): void {
    const camera = this.getEditorCamera();
    if (!camera) return;

    const mousePos = Engine.getInput().getMousePosition();
    const ray = this.screenToWorldRay(mousePos, camera);

    const result = Engine.getPhysics().raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);

    if (result) {
      const entity = Engine.getEntities().getEntityById(result.entityId);
      // Toggle off if same entity clicked again
      this.selectedEntity = entity && entity !== this.selectedEntity ? entity : null;
    } else {
      this.selectedEntity = null;
    }
  }

  private getEditorCamera(): CameraComponent | null {
    const debugCamera = Engine.getEntities().getEntityByName('DebugCamera');
    if (!debugCamera) return null;
    return debugCamera.getComponent('camera') as CameraComponent;
  }

  private screenToWorldRay(
    mousePos: { x: number; y: number },
    cameraComponent: CameraComponent,
  ): { origin: vec3; direction: vec3 } {
    const camera = cameraComponent.getCamera();
    const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();

    const x = ((mousePos.x - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((mousePos.y - rect.top) / rect.height) * 2;

    const rayClip = vec4.fromValues(x, y, 1, 1);

    const invProj = mat4.create();
    mat4.invert(invProj, camera.getProjection());
    const rayView = vec4.create();
    vec4.transformMat4(rayView, rayClip, invProj);
    rayView[0] /= rayView[3];
    rayView[1] /= rayView[3];
    rayView[2] /= rayView[3];
    rayView[3] = 0;

    const invView = mat4.create();
    mat4.invert(invView, camera.getView());
    const rayWorld4 = vec4.create();
    vec4.transformMat4(rayWorld4, rayView, invView);

    const worldDirection = vec3.fromValues(rayWorld4[0], rayWorld4[1], rayWorld4[2]);
    vec3.normalize(worldDirection, worldDirection);

    const worldOrigin = vec3.create();
    mat4.getTranslation(worldOrigin, invView);

    return { origin: worldOrigin, direction: worldDirection };
  }
}
