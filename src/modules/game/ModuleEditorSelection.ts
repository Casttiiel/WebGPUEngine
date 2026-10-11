import { Module } from '../core/Module';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';
import { CameraComponent } from '../../components/render/CameraComponent';
import { screenPointToRay } from '../../core/math/ScreenRay';
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
    const ray = screenPointToRay(mousePos.x, mousePos.y, camera.getCamera());

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
}
