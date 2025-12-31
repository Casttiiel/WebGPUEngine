import { Component } from '../../core/ecs/Component';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { BoxColliderComponent } from '../physics/BoxColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';
import { Entity } from '../../core/ecs/Entity';
import { SwingEntryData } from '../../types/SwingEntryData.type';

export class SwingBarComponent extends Component {
  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();
  private barStart: vec3 = vec3.create();
  private barEnd: vec3 = vec3.create();
  private barAxis: vec3 = vec3.create();
  private maxSwingAngle = Math.PI * 0.5; // 90°
  private maxGrabHeightRatio = 0.85; // demasiado arriba
  private minGrabHeightRatio = -0.85; // demasiado abajo
  private maxProgressAllowed = 0.5; // pasada la mitad no engancha

  constructor() {
    super();
  }

  public load(data: unknown): void {
    this.computeBarGeometry();
  }

  private computeBarGeometry(): void {
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    const barAxisLocal = vec3.fromValues(0, 0, 1); // eje Z local
    this.barAxis = transform.getTransform().rotateVector(barAxisLocal);
    vec3.normalize(this.barAxis, this.barAxis);
    const fullLength = transform.getTransform().getWorldScale()[2];
    const halfLength = fullLength * 0.5;
    const center = transform.getTransform().getWorldPosition();
    this.barStart = vec3.scaleAndAdd(vec3.create(), center, this.barAxis, -halfLength);
    this.barEnd = vec3.scaleAndAdd(vec3.create(), center, this.barAxis, halfLength);
  }

  private computeSwingEntry(entity: Entity): SwingEntryData | null {
    const playerTransform = entity.getComponent('transform') as TransformComponent;
    const playerPos = playerTransform.getTransform().getWorldPosition();

    // 1. Punto de enganche (proyección al eje)
    const toPlayer = vec3.sub(vec3.create(), playerPos, this.barStart);

    const barLength = vec3.distance(this.barStart, this.barEnd);
    let t = vec3.dot(toPlayer, this.barAxis);
    t = Math.max(0, Math.min(t, barLength));

    const attachPoint = vec3.scaleAndAdd(vec3.create(), this.barStart, this.barAxis, t);

    // 2. Vector radial (posición en el arco)
    const radial = vec3.sub(vec3.create(), playerPos, attachPoint);

    // 3. Base del arco (punto más bajo)
    const down = vec3.fromValues(0, -1, 0);
    const arcBase = this.projectOnPlane(down, this.barAxis);
    vec3.normalize(arcBase, arcBase);

    // 4. Tangente del arco
    const arcTangent = vec3.cross(vec3.create(), this.barAxis, arcBase);
    vec3.normalize(arcTangent, arcTangent);

    // 5. Ángulo inicial (DÓNDE EMPIEZAS EL SWING)
    const x = vec3.dot(radial, arcBase);
    const y = vec3.dot(radial, arcTangent);

    let initialAngle = Math.atan2(y, x);
    const sideSign = -Math.sign(initialAngle) || 1;

    const minAngle = -this.maxSwingAngle;
    const maxAngle = this.maxSwingAngle;

    if (initialAngle < minAngle || initialAngle > maxAngle) {
      return null;
    }

    // 7. Radio
    const radius = vec3.length(radial);

    const up = vec3.fromValues(0, 1, 0);
    const height = vec3.dot(radial, up);

    const maxGrabHeight = radius * this.maxGrabHeightRatio;
    const minGrabHeight = radius * this.minGrabHeightRatio;

    if (height > maxGrabHeight || height < minGrabHeight) {
      return null;
    }

    const controller = entity.getComponent('character_controller') as CharacterControllerComponent;
    const entryVelocity = controller.getCurrentHorizontalVelocity();
    const tangent = vec3.cross(vec3.create(), this.barAxis, radial);
    vec3.normalize(tangent, tangent);
    const direction = vec3.dot(entryVelocity, tangent) >= 0 ? 1 : -1;

    if (direction !== sideSign) {
      return null;
    }

    const endAngle = direction > 0 ? maxAngle : minAngle;
    const total = Math.abs(endAngle - initialAngle);
    const remaining = Math.abs(endAngle - initialAngle);

    const progress = total > 0 ? 1.0 - remaining / total : 1.0;

    if (progress > this.maxProgressAllowed) {
      return null;
    }

    return {
      attachPoint,
      radius,
      startAngle: initialAngle,
      endAngle: maxAngle * direction * 0.55,
      direction,
      barAxis: vec3.clone(this.barAxis),
    };
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  public override async onAttach(): Promise<void> {
    // Esperar un frame para asegurar que el box_collider está cargado
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Registrar callbacks del trigger
    this.setupTriggerCallbacks();
  }

  private setupTriggerCallbacks(): void {
    const boxCollider = this.getOwner().getComponent('box_collider') as BoxColliderComponent;

    if (!boxCollider) {
      console.warn('Swing bar: No se encontró box_collider (necesario para triggers)');
      return;
    }

    // Registrar callback para cuando algo ENTRA en el trigger
    boxCollider.onTriggerEnter((otherEntityId: number) => {
      this.onEntityEnter(otherEntityId);
    });

    // Registrar callback para cuando algo SALE del trigger
    boxCollider.onTriggerExit((otherEntityId: number) => {
      this.onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);

    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.add(entityId);
      const swingData = this.computeSwingEntry(entity);
      if (!swingData) return;
      (entity.getComponent('character_controller') as CharacterControllerComponent)?.startSwing(
        swingData,
      );
    }
  }

  private onEntityExit(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.delete(entityId);
    }
  }

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}

  private getUp(): vec3 {
    const transform = this.getOwner().getComponent('transform');
    if (!transform) {
      return vec3.create();
    }
    return (transform as TransformComponent).getTransform().getUp();
  }

  public getEntitiesInside(): Set<number> {
    return this.entitiesInside;
  }
}
