import { Component } from '../../core/ecs/Component';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { BoxColliderComponent } from '../physics/BoxColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';
import { Entity } from '../../core/ecs/Entity';
import { SwingEntryData } from '../../types/SwingEntryData.type';
import { CameraComponent } from '../render/CameraComponent';

export class SwingBarComponent extends Component {
  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();
  private barStart: vec3 = vec3.create();
  private barEnd: vec3 = vec3.create();
  private barAxis: vec3 = vec3.create();
  private maxStartSwingAngle = 2.0; // 90°
  private maxSwingAngle = 1.6; // 90°
  private maxGrabHeight = 0.65; // demasiado arriba
  private maxProgressAllowed = 0.5; // pasada la mitad no engancha

  // Sistema de cooldown para desactivar la barra temporalmente
  private isActive: boolean = true;
  private cooldownTime: number = 2.0; // segundos
  private cooldownTimer: number = 0.0;

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
    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCameraEntity) {
      return null;
    }
    const cameraComponent = mainCameraEntity.getComponent('camera');
    const mainCamera = (cameraComponent as CameraComponent).getCamera();
    const playerPos = mainCamera.getCameraPosition();

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

    const minAngle = -this.maxStartSwingAngle;
    const maxAngle = this.maxStartSwingAngle;
    if (initialAngle < minAngle || initialAngle > maxAngle) {
      console.log('descarte por angulo');
      return null;
    }

    // 7. Radio
    const radius = vec3.length(radial);

    if (playerPos[1] - attachPoint[1] > this.maxGrabHeight) {
      console.log('descarte por altura');
      return null;
    }

    const direction = initialAngle > 0 ? -1 : 1;

    const endAngle = initialAngle > 0 ? this.maxSwingAngle : -this.maxSwingAngle;
    const total = Math.abs(endAngle - initialAngle);
    const remaining = Math.abs(endAngle - initialAngle);

    const progress = total > 0 ? 1.0 - remaining / total : 1.0;

    if (progress > this.maxProgressAllowed) {
      console.log('descarte por progreso');
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
    // Ignorar si la barra está en cooldown
    if (!this.isActive) {
      return;
    }

    const entity = Engine.getPhysics().getEntityById(entityId);

    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.add(entityId);
      const swingData = this.computeSwingEntry(entity);
      if (!swingData) return;
      // Iniciar el swing y activar el cooldown
      (entity.getComponent('character_controller') as CharacterControllerComponent)?.startSwing(
        swingData,
      );

      // Desactivar la barra por 2 segundos
      this.startCooldown();
    }
  }

  private onEntityExit(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.delete(entityId);
    }
  }

  private startCooldown(): void {
    this.isActive = false;
    this.cooldownTimer = this.cooldownTime;
  }

  public update(dt: number): void {
    // Actualizar el cooldown
    if (!this.isActive) {
      this.cooldownTimer -= dt;
      if (this.cooldownTimer <= 0) {
        this.isActive = true;
        this.cooldownTimer = 0;
      }
    }
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {}

  public getEntitiesInside(): Set<number> {
    return this.entitiesInside;
  }
}
