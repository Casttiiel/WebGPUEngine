import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { SmoothStepInterpolator } from '../../../core/math/Interpolators';
import { DevBridge } from '../../../core/debug/DevBridge';
import { PhysicsDebugDrawer } from '../../../renderer/debug/PhysicsDebugDrawer';
import { CameraComponent } from '../../render/CameraComponent';
import { UnitComponent } from './UnitComponent';
import type { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { groundHeightAt, hasLineOfSight } from './TacticalQueries';

export type ActionCameraComponentDataType = Readonly<{
  /** Grados que se abre el plano respecto a la línea atacante→objetivo (por encima del hombro). */
  angle?: number;
  /** Inclinación del plano (grados bajo la horizontal). Más baja que la de juego. */
  pitch?: number;
  /** Distancia mínima y máxima del plano (m). */
  minDistance?: number;
  maxDistance?: number;
  /** Margen alrededor de las unidades al encuadrar (m). */
  margin?: number;
  /** Altura sobre el suelo del punto al que se mira. */
  lookHeight?: number;
  /** Fracción de la distancia que la cámara se acerca durante el plano (travelling lento). */
  push?: number;
  /** Segundos de la mezcla con la cámara de juego al entrar y al salir. */
  blendIn?: number;
  blendOut?: number;
  /** Segundos de pausa con la cámara ya colocada antes de que empiece la acción. */
  settle?: number;
  /** Segundos para reencuadrar si ya hay un plano en curso (acciones encadenadas). */
  reframe?: number;
  /** Cámara a la que se vuelve al acabar. Default 'PlayerCamera' (la del rig táctico). */
  gameplayCamera?: string;
  enabled?: boolean;
}>;

const DEG = Math.PI / 180;
const UP = vec3.fromValues(0, 1, 0);
/** Suavizado del encuadre mientras las unidades se mueven (1/s). */
const TRACK_SMOOTHING = 5;
/** Distancia mínima del ojo al suelo que tiene debajo. */
const MIN_EYE_CLEARANCE = 0.75;
/** Altura (sobre el centro de la cápsula) a la que se comprueba que se ve a cada unidad. */
const AIM_HEIGHT = 0.5;

/**
 * ActionCameraComponent — plano de acción para ataques y habilidades.
 *
 * Es una cámara aparte (entidad con `camera` + `action_camera`) que el ModuleCameraMixer
 * mezcla encima de la cámara de juego: al atacar se coloca detrás y a un lado del atacante,
 * más baja que la vista táctica, encuadrando al atacante y a sus objetivos, se acerca
 * despacio mientras se resuelve el golpe y después se mezcla de vuelta a la cámara de juego.
 *
 * La cámara táctica sigue funcionando por debajo (cambio de turno incluido), así que al
 * volver se ve lo que toque. Cualquier control de cámara del jugador corta el plano.
 */
export class ActionCameraComponent extends Component {
  private angle = 40;
  private pitch = 26;
  private minDistance = 4.5;
  private maxDistance = 24;
  private margin = 1.2;
  private lookHeight = 1.0;
  private push = 0.12;
  private blendIn = 0.45;
  private blendOut = 0.6;
  private settle = 0.2;
  private reframe = 0.35;
  private gameplayCamera = 'PlayerCamera';
  private shotsEnabled = true;

  private shot: {
    source: Entity;
    targets: (Entity | vec3)[];
    hold: number;
    elapsed: number;
  } | null = null;
  private yaw = 0;
  private targetYaw = 0;
  private distance = 0;
  private readonly center = vec3.create();
  private readonly targetCenter = vec3.create();
  private targetDistance = 0;

  private readonly tmpEye = vec3.create();
  private readonly tmpLook = vec3.create();
  private readonly tmpTestEye = vec3.create();
  private readonly tmpAim = vec3.create();

  public load(data: ActionCameraComponentDataType): void {
    this.angle = data.angle ?? this.angle;
    this.pitch = data.pitch ?? this.pitch;
    this.minDistance = data.minDistance ?? this.minDistance;
    this.maxDistance = data.maxDistance ?? this.maxDistance;
    this.margin = data.margin ?? this.margin;
    this.lookHeight = data.lookHeight ?? this.lookHeight;
    this.push = data.push ?? this.push;
    this.blendIn = data.blendIn ?? this.blendIn;
    this.blendOut = data.blendOut ?? this.blendOut;
    this.settle = data.settle ?? this.settle;
    this.reframe = data.reframe ?? this.reframe;
    this.gameplayCamera = data.gameplayCamera ?? this.gameplayCamera;
    this.shotsEnabled = data.enabled ?? this.shotsEnabled;
  }

  public override async onAttach(): Promise<void> {
    DevBridge.registerOverlay('action_camera', () => this.drawDebug());
  }

  public update(dt: number): void {
    const shot = this.shot;
    if (!shot) return;
    shot.elapsed += dt;
    if (shot.elapsed >= shot.hold || this.getTactical()?.hadUserInput()) {
      this.end();
      return;
    }
    // Sigue a las unidades (empujones, caídas) sin cambiar el ángulo del plano.
    const k = 1 - Math.exp(-TRACK_SMOOTHING * dt);
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * k;
    if (this.compose(shot.source, shot.targets, this.targetYaw)) {
      vec3.lerp(this.center, this.center, this.targetCenter, k);
      this.distance += (this.targetDistance - this.distance) * k;
    }
    this.apply(shot.elapsed / shot.hold);
  }

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * Encuadra a `source` y a sus objetivos (unidades o puntos del suelo). Devuelve los segundos
   * que tarda la cámara en estar colocada (0 si no hay plano): la acción debe empezar entonces.
   * El plano dura `hold` segundos desde ese momento. Si ya hay uno en curso, reencuadra
   * suavemente y lo alarga.
   */
  public frameAction(source: Entity, targets: (Entity | vec3)[], hold: number): number {
    if (!this.shotsEnabled || Engine.getModules().getCurrentGamestate() !== 'gs_gameplay') return 0;
    const yaw = this.chooseYaw(source, targets);
    if (yaw === null || !this.compose(source, targets, yaw)) return 0;

    if (!this.shot) {
      // Entra con un corte de encuadre: el mixer se encarga de que no se note.
      this.yaw = yaw;
      this.targetYaw = yaw;
      vec3.copy(this.center, this.targetCenter);
      this.distance = this.targetDistance;
      const ready = this.blendIn + this.settle;
      this.shot = { source, targets, hold: ready + hold, elapsed: 0 };
      this.apply(0);
      Engine.getCameraMixer().blendCamera(
        this.getOwner(),
        this.blendIn,
        new SmoothStepInterpolator(),
      );
      return ready;
    }
    this.targetYaw = this.yaw + shortestAngle(this.yaw, yaw);
    this.shot.source = source;
    this.shot.targets = targets;
    this.shot.hold = Math.max(this.shot.hold, this.shot.elapsed + this.reframe + hold);
    return this.reframe;
  }

  /** Alarga el plano en curso hasta `seconds` desde ahora (p.ej. para ver caer al objetivo). */
  public holdShot(seconds: number): void {
    if (this.shot) this.shot.hold = Math.max(this.shot.hold, this.shot.elapsed + seconds);
  }

  public isInShot(): boolean {
    return this.shot !== null;
  }

  public isShotsEnabled(): boolean {
    return this.shotsEnabled;
  }

  public setShotsEnabled(enabled: boolean): void {
    this.shotsEnabled = enabled;
    if (!enabled) this.end();
  }

  /** Vuelve a la cámara de juego. */
  public end(): void {
    if (!this.shot) return;
    this.shot = null;
    const gameplay = Engine.getEntities().getEntityByName(this.gameplayCamera);
    if (gameplay && Engine.getModules().getCurrentGamestate() === 'gs_gameplay') {
      Engine.getCameraMixer().blendCamera(gameplay, this.blendOut, new SmoothStepInterpolator());
    }
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /**
   * Mirando de atacante a objetivos, abierto `angle` grados hacia un lado: el que deje ver a
   * más unidades (sin muros ni columnas delante) y, a igualdad, el más cercano a la vista
   * actual (el cambio de plano se lee mejor). null si no hay dirección.
   */
  private chooseYaw(source: Entity, targets: (Entity | vec3)[]): number | null {
    const points = this.collect(source, targets);
    if (points.length < 2) return null;
    const from = points[0]!;
    let dx = 0;
    let dz = 0;
    for (const p of points) {
      dx += p[0]! - from[0]!;
      dz += p[2]! - from[2]!;
    }
    if (Math.hypot(dx, dz) < 0.3) return null;
    const along = Math.atan2(dx, dz) / DEG;
    const current = this.shot ? this.yaw : (this.getTactical()?.getYaw() ?? along);
    const sides = [along + this.angle, along - this.angle]
      .map((yaw) => current + shortestAngle(current, yaw))
      .sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
    let best = sides[0]!;
    let bestBlocked = Infinity;
    for (const yaw of sides) {
      if (!this.compose(source, targets, yaw)) continue;
      const eye = this.eyeFor(this.targetCenter, this.targetDistance, yaw, this.tmpTestEye);
      const blocked = points.filter((p) => {
        const aim = vec3.set(this.tmpAim, p[0]!, p[1]! + AIM_HEIGHT, p[2]!);
        return !hasLineOfSight(eye, aim);
      }).length;
      if (blocked < bestBlocked) {
        best = yaw;
        bestBlocked = blocked;
      }
    }
    return best;
  }

  /** Posición del ojo para un encuadre (centro en el suelo, distancia, yaw en grados). */
  private eyeFor(center: vec3, distance: number, yawDeg: number, out: vec3): vec3 {
    const pitch = this.pitch * DEG;
    const yaw = yawDeg * DEG;
    const lookY = center[1]! + this.lookHeight;
    vec3.set(
      out,
      center[0]! - Math.sin(yaw) * Math.cos(pitch) * distance,
      lookY + Math.sin(pitch) * distance,
      center[2]! - Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    const ground = groundHeightAt(out[0]!, out[2]!);
    if (ground !== null && out[1]! < ground + MIN_EYE_CLEARANCE) {
      out[1] = ground + MIN_EYE_CLEARANCE;
    }
    return out;
  }

  /** Punto al que mira el plano en curso (los oclusores lo dejan a la vista). null fuera de un plano. */
  public getLookPoint(): vec3 | null {
    return this.shot ? this.tmpLook : null;
  }

  /** Centro y distancia que encuadran a todos con la vista `yaw` → targetCenter/targetDistance. */
  private compose(source: Entity, targets: (Entity | vec3)[], yaw: number): boolean {
    const points = this.collect(source, targets);
    if (points.length < 2) return false;
    const fx = Math.sin(yaw * DEG);
    const fz = Math.cos(yaw * DEG);
    let minR = Infinity;
    let maxR = -Infinity;
    let minF = Infinity;
    let maxF = -Infinity;
    let minY = Infinity;
    for (const p of points) {
      const r = -fz * p[0]! + fx * p[2]!;
      const f = fx * p[0]! + fz * p[2]!;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minF = Math.min(minF, f);
      maxF = Math.max(maxF, f);
      minY = Math.min(minY, groundHeightAt(p[0]!, p[2]!) ?? p[1]!);
    }
    const midR = (minR + maxR) / 2;
    const midF = (minF + maxF) / 2;
    vec3.set(this.targetCenter, -fz * midR + fx * midF, minY, fx * midR + fz * midF);

    // Distancia para que cada punto quepa en pantalla a su propia profundidad: el atacante
    // está más cerca de la cámara que el centro, así que con perspectiva ocupa más.
    const camera = (this.getOwner().getComponent('camera') as CameraComponent).getCamera();
    const tanV = Math.tan(camera.getFov() / 2);
    const tanH = tanV * camera.getAspectRatio();
    const sinP = Math.sin(this.pitch * DEG);
    const cosP = Math.cos(this.pitch * DEG);
    let needed = 0;
    for (const p of points) {
      const r = Math.abs(-fz * p[0]! + fx * p[2]! - midR) + this.margin;
      const f = fx * p[0]! + fz * p[2]! - midF;
      const depthOffset = f * cosP; // + más lejos que el centro
      needed = Math.max(
        needed,
        r / tanH - depthOffset,
        (Math.abs(f) * sinP + this.margin) / tanV - depthOffset,
      );
    }
    // El travelling acerca la cámara al final del plano: que sigan cabiendo.
    this.targetDistance = clamp(needed / (1 - this.push), this.minDistance, this.maxDistance);
    return true;
  }

  /** Posiciones del atacante (primero) y de los objetivos que siguen existiendo. */
  private collect(source: Entity, targets: (Entity | vec3)[]): vec3[] {
    const unit = source.getComponent('unit') as UnitComponent | null;
    if (!unit) return [];
    const points = [unit.getPosition(vec3.create())];
    for (const t of targets) {
      if (t instanceof Entity) {
        const u = t.getComponent('unit') as UnitComponent | null;
        if (u && t !== source) points.push(u.getPosition(vec3.create()));
      } else {
        points.push(vec3.clone(t));
      }
    }
    return points;
  }

  /** Coloca la cámara. `t` (0..1): progreso del plano, para el travelling hacia dentro. */
  private apply(t: number): void {
    const ease = t * t * (3 - 2 * t);
    const distance = this.distance * (1 - this.push * ease);
    vec3.set(this.tmpLook, this.center[0]!, this.center[1]! + this.lookHeight, this.center[2]!);
    this.eyeFor(this.center, distance, this.yaw, this.tmpEye);
    const camera = (this.getOwner().getComponent('camera') as CameraComponent).getCamera();
    camera.lookAt(this.tmpEye, this.tmpLook, UP);
  }

  private getTactical(): TacticalCameraControllerComponent | null {
    const list = Engine.getEntities()
      .getObjectManagerByName('tactical_camera_controller')
      ?.getList();
    return (list?.[0] as TacticalCameraControllerComponent | undefined) ?? null;
  }

  private drawDebug(): void {
    if (!this.shot) return;
    const d = PhysicsDebugDrawer.getInstance();
    const c: [number, number, number, number] = [1, 0.3, 1, 1];
    d.addLine(
      this.tmpEye[0]!,
      this.tmpEye[1]!,
      this.tmpEye[2]!,
      this.tmpLook[0]!,
      this.tmpLook[1]!,
      this.tmpLook[2]!,
      c,
    );
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
