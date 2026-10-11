import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { CameraComponent } from '../../render/CameraComponent';
import { KeyCode } from '../../../types/KeyCode.enum';
import { MouseButton } from '../../../types/MouseButton.enum';
import { Render } from '../../../renderer/core/pipeline/Render';
import { PhysicsDebugDrawer } from '../../../renderer/debug/PhysicsDebugDrawer';
import { DevBridge } from '../../../core/debug/DevBridge';
import { UnitComponent } from './UnitComponent';

export type TacticalCameraControllerData = Readonly<{
  /** Pivot inicial (punto del suelo al que mira la cámara). Default [0,0,0]. */
  pivot?: [number, number, number];
  /** Orientación inicial en grados. 0 = la cámara mira hacia +Z. */
  yaw?: number;
  /** Distancia inicial cámara-pivot (m). */
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Inclinación (grados bajo la horizontal) con el zoom al mínimo y al máximo. */
  pitchNear?: number;
  pitchFar?: number;
  /** Altura sobre el suelo del punto al que se mira (centra a los personajes). */
  lookHeight?: number;
  /** Velocidad de pan con teclado/bordes, en fracciones de la distancia por segundo. */
  panSpeed?: number;
  edgePan?: boolean;
  /** Píxeles desde el borde del canvas que activan el edge-pan. */
  edgePanMargin?: number;
  /** Rotación con Q/E (grados/s). */
  rotateSpeed?: number;
  /** Rotación con botón central + Shift/Alt (grados por píxel). */
  dragRotateSensitivity?: number;
  /** Sensibilidad de la rueda (zoom exponencial). */
  zoomSensitivity?: number;
  /** Suavizado de pivot/yaw/zoom (1/s; mayor = más rápido). */
  smoothing?: number;
  /** Suavizado de la altura del pivot (1/s). Más lento que el resto para no dar tirones. */
  heightSmoothing?: number;
  /** Distancia mínima del ojo al suelo que tiene debajo. */
  minEyeClearance?: number;
  /** Límites del pivot en XZ. */
  bounds?: { min: [number, number]; max: [number, number] };
  /** Unidad a seguir al empezar (nombre). Default: primera unidad de la party. */
  followOnStart?: string | false;
}>;

const DEG = Math.PI / 180;
const UP = vec3.fromValues(0, 1, 0);

/**
 * TacticalCameraControllerComponent — controller de cámara estilo BG3.
 *
 * Mismo patrón que CameraArmComponent / FPSCameraControllerComponent: el controller vive
 * en una entidad y mueve la `camera` de su entidad hija. La diferencia es que aquí la
 * entidad dueña es un *rig* independiente, no el personaje: la cámara se mueve libremente
 * y el seguimiento es una referencia a una unidad que se activa/desactiva.
 *
 *   TacticalCameraRig [tactical_camera_controller]
 *   └── PlayerCamera  [camera]
 *
 * Controles:
 *   WASD / flechas / bordes de pantalla  pan (desactiva el seguimiento)
 *   Botón central + arrastrar            pan "agarrando" el suelo
 *   Botón central + Shift/Alt + arrastrar, Q/E   rotar
 *   Rueda                                zoom (más cenital cuanto más lejos)
 *   F                                    activar/desactivar seguir a la unidad activa
 *   Inicio (Home)                        centrar y seguir la unidad activa
 *   Tab / Shift+Tab                      cambiar de unidad activa (hasta que exista la party)
 */
export class TacticalCameraControllerComponent extends Component {
  // ── Config ──────────────────────────────────────────────────────────────────
  private minDistance = 6;
  private maxDistance = 32;
  private pitchNear = 40;
  private pitchFar = 62;
  private lookHeight = 1.0;
  private panSpeed = 0.9;
  private edgePan = true;
  private edgePanMargin = 10;
  private rotateSpeed = 110;
  private dragRotateSensitivity = 0.3;
  private zoomSensitivity = 0.0012;
  private smoothing = 8;
  private heightSmoothing = 3;
  private minEyeClearance = 0.75;
  private bounds: { min: [number, number]; max: [number, number] } | null = null;
  private followOnStart: string | false | null = null;

  // ── Estado (target = hacia donde va; current = lo que se ve, suavizado) ────
  private targetPivot = vec3.create();
  private pivot = vec3.create();
  private targetYaw = 0;
  private yaw = 0;
  private targetDistance = 16;
  private distance = 16;

  private followTarget: Entity | null = null;
  private followEnabled = false;
  private activeUnit: Entity | null = null;
  private active = true;
  private initialized = false;

  private cameraEntity: Entity | null = null;

  // Temporales reutilizables
  private readonly tmpForward = vec3.create();
  private readonly tmpRight = vec3.create();
  private readonly tmpEye = vec3.create();
  private readonly tmpLook = vec3.create();
  private readonly tmpUnitPos = vec3.create();

  public load(data: TacticalCameraControllerData): void {
    if (data.pivot) vec3.set(this.targetPivot, data.pivot[0], data.pivot[1], data.pivot[2]);
    this.minDistance = data.minDistance ?? this.minDistance;
    this.maxDistance = data.maxDistance ?? this.maxDistance;
    this.targetDistance = clamp(
      data.distance ?? this.targetDistance,
      this.minDistance,
      this.maxDistance,
    );
    this.targetYaw = data.yaw ?? 0;
    this.pitchNear = data.pitchNear ?? this.pitchNear;
    this.pitchFar = data.pitchFar ?? this.pitchFar;
    this.lookHeight = data.lookHeight ?? this.lookHeight;
    this.panSpeed = data.panSpeed ?? this.panSpeed;
    this.edgePan = data.edgePan ?? this.edgePan;
    this.edgePanMargin = data.edgePanMargin ?? this.edgePanMargin;
    this.rotateSpeed = data.rotateSpeed ?? this.rotateSpeed;
    this.dragRotateSensitivity = data.dragRotateSensitivity ?? this.dragRotateSensitivity;
    this.zoomSensitivity = data.zoomSensitivity ?? this.zoomSensitivity;
    this.smoothing = data.smoothing ?? this.smoothing;
    this.heightSmoothing = data.heightSmoothing ?? this.heightSmoothing;
    this.minEyeClearance = data.minEyeClearance ?? this.minEyeClearance;
    this.bounds = data.bounds ?? null;
    this.followOnStart = data.followOnStart ?? null;

    vec3.copy(this.pivot, this.targetPivot);
    this.yaw = this.targetYaw;
    this.distance = this.targetDistance;
  }

  public override async onAttach(): Promise<void> {
    // Cámara táctica = cursor libre: sin pointer lock, el ratón se usa para apuntar/clicar.
    Engine.getInput().setPointerLockEnabled(false);
    DevBridge.registerOverlay('camera', () => this.drawDebug());
  }

  public update(dt: number): void {
    if (!this.cameraEntity) {
      this.cameraEntity =
        this.getOwner()
          .getChildren()
          .find((c) => c.hasComponent('camera')) ?? null;
      if (!this.cameraEntity) return;
    }
    if (!this.initialized) this.initialize();

    if (this.active) this.handleInput(dt);

    // Seguimiento: el pivot objetivo va pegado a la unidad mientras esté activo.
    if (this.followEnabled && this.followTarget) {
      const unit = this.followTarget.getComponent('unit') as UnitComponent | null;
      if (unit) {
        unit.getPosition(this.tmpUnitPos);
        this.targetPivot[0] = this.tmpUnitPos[0]!;
        this.targetPivot[2] = this.tmpUnitPos[2]!;
      }
    }
    this.clampToBounds(this.targetPivot);
    this.targetPivot[1] =
      this.groundHeightAt(this.targetPivot[0]!, this.targetPivot[2]!) ?? this.targetPivot[1]!;

    // Suavizado exponencial (independiente del framerate).
    const k = 1 - Math.exp(-this.smoothing * dt);
    this.pivot[0] = this.pivot[0]! + (this.targetPivot[0]! - this.pivot[0]!) * k;
    this.pivot[2] = this.pivot[2]! + (this.targetPivot[2]! - this.pivot[2]!) * k;
    // La altura va más lenta: al pasar sobre cajas o muros bajos la vista no da tirones.
    const kHeight = 1 - Math.exp(-this.heightSmoothing * dt);
    this.pivot[1] = this.pivot[1]! + (this.targetPivot[1]! - this.pivot[1]!) * kHeight;
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * k;
    this.distance += (this.targetDistance - this.distance) * k;

    this.applyToCamera();
  }

  // ── API pública (la usarán party/turnos/UI) ────────────────────────────────

  public setActive(active: boolean): void {
    this.active = active;
  }

  /** Centra la cámara en una unidad (o posición). Con `follow` la sigue después. */
  public focusOn(target: Entity | vec3, follow = false): void {
    if (target instanceof Entity) {
      const unit = target.getComponent('unit') as UnitComponent | null;
      if (unit) unit.getPosition(this.tmpUnitPos);
      else vec3.zero(this.tmpUnitPos);
      vec3.set(this.targetPivot, this.tmpUnitPos[0]!, this.targetPivot[1]!, this.tmpUnitPos[2]!);
      this.followTarget = target;
      this.followEnabled = follow;
    } else {
      vec3.set(this.targetPivot, target[0]!, this.targetPivot[1]!, target[2]!);
      this.followEnabled = false;
    }
  }

  /** Sigue a una unidad (transición suave). null = dejar de seguir. */
  public follow(entity: Entity | null): void {
    if (!entity) {
      this.followEnabled = false;
      return;
    }
    this.focusOn(entity, true);
  }

  public setFollowEnabled(enabled: boolean): void {
    if (enabled) {
      const target = this.followTarget ?? this.activeUnit;
      if (target) this.focusOn(target, true);
    } else {
      this.followEnabled = false;
    }
  }

  public isFollowing(): boolean {
    return this.followEnabled && this.followTarget !== null;
  }

  /** Unidad "activa" (la que enfoca Home / F). La party y los turnos la irán cambiando. */
  public setActiveUnit(entity: Entity | null, follow = true): void {
    this.activeUnit = entity;
    if (entity && follow) this.focusOn(entity, true);
  }

  public getActiveUnit(): Entity | null {
    return this.activeUnit;
  }

  public getPivot(): vec3 {
    return this.pivot;
  }

  public getYaw(): number {
    return this.yaw;
  }

  public getDistance(): number {
    return this.distance;
  }

  public getPitch(): number {
    return this.pitchForDistance(this.distance);
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  private initialize(): void {
    this.initialized = true;
    const units = UnitComponent.getAll();
    const byName =
      typeof this.followOnStart === 'string'
        ? Engine.getEntities().getEntityByName(this.followOnStart)
        : null;
    const first = byName ?? units.find((u) => u.getFaction() === 'party')?.getOwner() ?? null;
    this.activeUnit = first;
    if (first && this.followOnStart !== false) {
      this.focusOn(first, true);
      // Primera colocación sin transición.
      this.targetPivot[1] = this.groundHeightAt(this.targetPivot[0]!, this.targetPivot[2]!) ?? 0;
      vec3.copy(this.pivot, this.targetPivot);
    }
  }

  private handleInput(dt: number): void {
    const input = Engine.getInput();
    const shift = input.isKeyPressed(KeyCode.SHIFT) || input.isKeyPressed('shiftright' as KeyCode);
    const alt = input.isKeyPressed(KeyCode.ALT) || input.isKeyPressed('altright' as KeyCode);

    // Ejes del plano XZ según el yaw actual (pan relativo a la vista).
    vec3.set(this.tmpForward, Math.sin(this.yaw * DEG), 0, Math.cos(this.yaw * DEG));
    vec3.set(this.tmpRight, -this.tmpForward[2]!, 0, this.tmpForward[0]!);

    // ── Pan con teclado y bordes ──────────────────────────────────────────
    let moveF = 0;
    let moveR = 0;
    if (input.isKeyPressed(KeyCode.W) || input.isKeyPressed(KeyCode.ARROW_UP)) moveF += 1;
    if (input.isKeyPressed(KeyCode.S) || input.isKeyPressed(KeyCode.ARROW_DOWN)) moveF -= 1;
    if (input.isKeyPressed(KeyCode.D) || input.isKeyPressed(KeyCode.ARROW_RIGHT)) moveR += 1;
    if (input.isKeyPressed(KeyCode.A) || input.isKeyPressed(KeyCode.ARROW_LEFT)) moveR -= 1;

    const middle = input.isMouseButtonPressed(MouseButton.MIDDLE);
    if (this.edgePan && !middle && input.isMouseInWindow()) {
      const rect = Render.getInstance().getCanvas().getBoundingClientRect();
      const m = input.getMousePosition();
      const x = m.x - rect.left;
      const y = m.y - rect.top;
      if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) {
        if (x < this.edgePanMargin) moveR -= 1;
        else if (x > rect.width - this.edgePanMargin) moveR += 1;
        if (y < this.edgePanMargin) moveF += 1;
        else if (y > rect.height - this.edgePanMargin) moveF -= 1;
      }
    }

    if (moveF !== 0 || moveR !== 0) {
      const len = Math.hypot(moveF, moveR);
      const speed = this.panSpeed * this.distance * dt;
      vec3.scaleAndAdd(this.targetPivot, this.targetPivot, this.tmpForward, (moveF / len) * speed);
      vec3.scaleAndAdd(this.targetPivot, this.targetPivot, this.tmpRight, (moveR / len) * speed);
      this.followEnabled = false;
    }

    // ── Botón central: pan agarrando el suelo, o rotar con modificador ─────
    if (middle) {
      const delta = input.getMouseDelta();
      if (shift || alt) {
        this.targetYaw -= delta.x * this.dragRotateSensitivity;
      } else if (delta.x !== 0 || delta.y !== 0) {
        // Metros por píxel en el plano del pivot → el suelo se mueve con el cursor.
        const camera = (this.cameraEntity!.getComponent('camera') as CameraComponent).getCamera();
        const height = Render.getInstance().getCanvas().clientHeight || Render.height;
        // getFov() devuelve radianes.
        const metersPerPixel = (2 * this.distance * Math.tan(camera.getFov() / 2)) / height;
        const pitchFactor = 1 / Math.max(0.3, Math.sin(this.getPitch() * DEG));
        vec3.scaleAndAdd(
          this.targetPivot,
          this.targetPivot,
          this.tmpRight,
          -delta.x * metersPerPixel,
        );
        vec3.scaleAndAdd(
          this.targetPivot,
          this.targetPivot,
          this.tmpForward,
          delta.y * metersPerPixel * pitchFactor,
        );
        // Arrastre directo, sin lag: el suelo debe quedarse "pegado" al cursor.
        this.pivot[0] = this.targetPivot[0]!;
        this.pivot[2] = this.targetPivot[2]!;
        this.followEnabled = false;
      }
    }

    // ── Rotación con Q/E ───────────────────────────────────────────────────
    if (input.isKeyPressed(KeyCode.Q)) this.targetYaw += this.rotateSpeed * dt;
    if (input.isKeyPressed(KeyCode.E)) this.targetYaw -= this.rotateSpeed * dt;

    // ── Zoom ───────────────────────────────────────────────────────────────
    const wheel = input.getMouseWheelDelta();
    if (wheel !== 0) {
      this.targetDistance = clamp(
        this.targetDistance * Math.exp(wheel * this.zoomSensitivity),
        this.minDistance,
        this.maxDistance,
      );
    }

    // ── Seguimiento / unidad activa ────────────────────────────────────────
    if (input.isKeyJustPressed(KeyCode.TAB)) this.cycleActiveUnit(shift ? -1 : 1);
    if (input.isKeyJustPressed(KeyCode.HOME) && this.activeUnit)
      this.focusOn(this.activeUnit, true);
    if (input.isKeyJustPressed(KeyCode.F)) this.setFollowEnabled(!this.isFollowing());
  }

  private cycleActiveUnit(direction: 1 | -1): void {
    const units = UnitComponent.getAll().map((u) => u.getOwner());
    if (!units.length) return;
    const index = this.activeUnit ? units.indexOf(this.activeUnit) : -1;
    const next = units[(index + direction + units.length) % units.length]!;
    this.setActiveUnit(next, true);
  }

  private pitchForDistance(distance: number): number {
    const t = clamp((distance - this.minDistance) / (this.maxDistance - this.minDistance), 0, 1);
    return this.pitchNear + (this.pitchFar - this.pitchNear) * t;
  }

  private applyToCamera(): void {
    const pitch = this.pitchForDistance(this.distance) * DEG;
    const yaw = this.yaw * DEG;

    vec3.set(this.tmpLook, this.pivot[0]!, this.pivot[1]! + this.lookHeight, this.pivot[2]!);
    // El ojo queda detrás del pivot (opuesto a la dirección de vista) y por encima.
    vec3.set(
      this.tmpEye,
      this.tmpLook[0]! - Math.sin(yaw) * Math.cos(pitch) * this.distance,
      this.tmpLook[1]! + Math.sin(pitch) * this.distance,
      this.tmpLook[2]! - Math.cos(yaw) * Math.cos(pitch) * this.distance,
    );

    // Nunca por debajo del suelo (u obstáculo) que tenga debajo el ojo.
    const groundUnderEye = this.groundHeightAt(this.tmpEye[0]!, this.tmpEye[2]!);
    if (groundUnderEye !== null && this.tmpEye[1]! < groundUnderEye + this.minEyeClearance) {
      this.tmpEye[1] = groundUnderEye + this.minEyeClearance;
    }

    const camera = (this.cameraEntity!.getComponent('camera') as CameraComponent).getCamera();
    camera.lookAt(this.tmpEye, this.tmpLook, UP);
  }

  /** Altura del suelo estático en (x,z): raycast hacia abajo ignorando unidades y sensores. */
  private groundHeightAt(x: number, z: number): number | null {
    const physics = Engine.getPhysics();
    const world = physics?.getWorld();
    if (!world) return null;
    const top = 200;
    const ray = new RAPIER.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(
      ray,
      400,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => !collider.isSensor() && (collider.parent()?.isFixed() ?? true),
    );
    return hit ? top - hit.timeOfImpact : null;
  }

  private clampToBounds(p: vec3): void {
    if (!this.bounds) return;
    p[0] = clamp(p[0]!, this.bounds.min[0], this.bounds.max[0]);
    p[2] = clamp(p[2]!, this.bounds.min[1], this.bounds.max[1]);
  }

  private drawDebug(): void {
    const d = PhysicsDebugDrawer.getInstance();
    const p = this.pivot;
    const c: [number, number, number, number] = this.isFollowing()
      ? [0, 1, 0.4, 1]
      : [1, 0.8, 0, 1];
    const y = p[1]! + 0.05;
    d.addLine(p[0]! - 0.5, y, p[2]!, p[0]! + 0.5, y, p[2]!, c);
    d.addLine(p[0]!, y, p[2]! - 0.5, p[0]!, y, p[2]! + 0.5, c);
    d.addLine(p[0]!, y, p[2]!, p[0]!, y + this.lookHeight, p[2]!, c);
    if (this.bounds) {
      const { min, max } = this.bounds;
      const b: [number, number, number, number] = [1, 0.3, 0.3, 1];
      d.addLine(min[0], y, min[1], max[0], y, min[1], b);
      d.addLine(max[0], y, min[1], max[0], y, max[1], b);
      d.addLine(max[0], y, max[1], min[0], y, max[1], b);
      d.addLine(min[0], y, max[1], min[0], y, min[1], b);
    }
  }

  public override renderInMenu(): void {}
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Diferencia angular más corta (grados) de `from` a `to`. */
function shortestAngle(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}
