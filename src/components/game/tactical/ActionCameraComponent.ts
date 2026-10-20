import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { SmoothStepInterpolator } from '../../../core/math/Interpolators';
import { DevBridge } from '../../../core/debug/DevBridge';
import { PhysicsDebugDrawer } from '../../../renderer/debug/PhysicsDebugDrawer';
import { CameraComponent } from '../../render/CameraComponent';
import { UnitComponent, type UnitFaction } from './UnitComponent';
import type { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { groundHeightAt, hasLineOfSight } from './TacticalQueries';
import { CharacterSheetController } from '../../../core/ui/controllers/CharacterSheetController';

/** Qué se está encuadrando: decide qué planos pueden salir. */
export type ShotKind = 'melee' | 'ranged' | 'skill' | 'throw' | 'push' | 'aim';

/**
 * Movimiento de cámara durante el plano. `amount`: fracción de la distancia (push/pull) o
 * grados (orbit: giro alrededor del centro; crane: cuánto sube la inclinación).
 */
export type ShotMove = Readonly<{
  type: 'push' | 'pull' | 'orbit' | 'crane' | 'static';
  amount?: number;
  weight?: number;
}>;

export type ShotDef = Readonly<{
  id: string;
  /**
   * Grados que se abre el plano respecto a la línea atacante→objetivos (0 = desde detrás del
   * atacante, 90 = de perfil, 180 = desde detrás de los objetivos). El lado se elige solo.
   */
  angle: number;
  /** Inclinación (grados bajo la horizontal; negativa = contrapicado). */
  pitch: number;
  /** Campo de visión vertical (grados). Default: el de la cámara del prefab. */
  fov?: number;
  /** Altura sobre el suelo del punto al que se mira. Default: `lookHeight` del componente. */
  lookHeight?: number;
  /** Inclinación lateral de la cámara (grados; el sentido se elige al azar). */
  roll?: number;
  /** Probabilidad relativa frente a los demás planos que encajen. */
  weight?: number;
  /** Solo para estas acciones (sin lista = todas). */
  kinds?: readonly ShotKind[];
  /** Solo si actúa alguien de estos bandos (sin lista = cualquiera). */
  factions?: readonly UnitFaction[];
  /** Número de objetivos (unidades o puntos) para que valga el plano. */
  minTargets?: number;
  maxTargets?: number;
  /** Movimientos posibles (se elige uno con su peso). Default: push 0.12. */
  moves?: readonly ShotMove[];
}>;

export type ActionCameraComponentDataType = Readonly<{
  /** Catálogo de planos. Default: DEFAULT_SHOTS. */
  shots?: readonly ShotDef[];
  /** Distancia mínima y máxima del plano (m). */
  minDistance?: number;
  maxDistance?: number;
  /** Margen alrededor de las unidades al encuadrar (m). */
  margin?: number;
  /** Altura sobre el suelo del punto al que se mira (si el plano no dice otra). */
  lookHeight?: number;
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

/**
 * Planos por defecto. Hombro para todo; contraplano (desde detrás de la víctima) cuando
 * ataca un enemigo; perfil bajo con teleobjetivo para golpes y empujones; contrapicado para
 * habilidades y golpes; cenital para áreas con varios afectados.
 */
export const DEFAULT_SHOTS: readonly ShotDef[] = [
  {
    id: 'shoulder',
    angle: 40,
    pitch: 26,
    weight: 3,
    moves: [
      { type: 'push', amount: 0.12, weight: 2 },
      { type: 'orbit', amount: 10 },
    ],
  },
  {
    id: 'shoulder_low',
    angle: 28,
    pitch: 13,
    fov: 38,
    lookHeight: 1.2,
    weight: 1.5,
    kinds: ['melee', 'ranged', 'skill'],
    maxTargets: 2,
    moves: [
      { type: 'push', amount: 0.15 },
      { type: 'crane', amount: 6 },
    ],
  },
  {
    id: 'reverse',
    angle: 150,
    pitch: 18,
    weight: 4,
    kinds: ['melee', 'ranged', 'skill'],
    factions: ['enemy'],
    maxTargets: 1,
    moves: [{ type: 'push', amount: 0.1, weight: 2 }, { type: 'static' }],
  },
  {
    id: 'profile',
    angle: 90,
    pitch: 8,
    fov: 30,
    lookHeight: 1.1,
    weight: 2,
    kinds: ['melee', 'push', 'throw'],
    maxTargets: 3,
    moves: [{ type: 'static' }, { type: 'push', amount: 0.06 }, { type: 'orbit', amount: 6 }],
  },
  {
    id: 'low_angle',
    angle: 22,
    pitch: -6,
    fov: 50,
    lookHeight: 1.5,
    roll: 4,
    weight: 1,
    kinds: ['melee', 'skill'],
    maxTargets: 2,
    moves: [{ type: 'push', amount: 0.1 }, { type: 'static' }],
  },
  {
    id: 'overhead',
    angle: 12,
    pitch: 62,
    weight: 4,
    kinds: ['skill', 'throw', 'push', 'aim'],
    minTargets: 3,
    moves: [
      { type: 'orbit', amount: 15, weight: 2 },
      { type: 'pull', amount: 0.1 },
    ],
  },
];

const DEFAULT_MOVE: ShotMove = { type: 'push', amount: 0.12 };

const DEG = Math.PI / 180;
const UP = vec3.fromValues(0, 1, 0);
/** Suavizado del encuadre mientras las unidades se mueven (1/s). */
const TRACK_SMOOTHING = 5;
/** Distancia mínima del ojo al suelo que tiene debajo. */
const MIN_EYE_CLEARANCE = 0.75;
/** Altura (sobre el centro de la cápsula) a la que se comprueba que se ve a cada unidad. */
const AIM_HEIGHT = 0.5;
/** Temblor: frecuencia de la sacudida (Hz) y segundos que dura. */
const SHAKE_FREQUENCY = 22;
const SHAKE_TIME = 0.35;
/** Penalización de los planos recientes (el último, el penúltimo…). */
const RECENT_PENALTY = [0.2, 0.5, 0.8];
/** Preferencia por seguir con el mismo plano al reencuadrar (acciones encadenadas). */
const CONTINUITY_BONUS = 3;
/** Peso de un encuadre en el que no caben todos (a la distancia máxima). */
const UNFIT_PENALTY = 0.05;
/** Fracción del alto de pantalla útil para encuadrar (la hotbar tapa la parte de abajo). */
const VERTICAL_SAFE = 0.8;

type Shot = {
  source: Entity;
  targets: (Entity | vec3)[];
  hold: number;
  elapsed: number;
  /** Plano de apuntar: dura hasta endAim (o hasta que se ejecute la acción). */
  aiming: boolean;
  def: ShotDef;
  move: ShotMove;
  /** Sentido del giro (orbit) y de la inclinación lateral: ±1. */
  sign: number;
};

type Choice = { def: ShotDef; yaw: number };

/**
 * ActionCameraComponent — plano de acción para ataques y habilidades.
 *
 * Es una cámara aparte (entidad con `camera` + `action_camera`) que el ModuleCameraMixer
 * mezcla encima de la cámara de juego: al atacar elige un plano del catálogo (`shots`) según
 * la acción, quién la hace y cuántos objetivos hay, lo coloca encuadrando al atacante y a sus
 * objetivos, lo mueve despacio (acercarse, alejarse, girar, subir) mientras se resuelve el
 * golpe y después se mezcla de vuelta a la cámara de juego. Entre los planos que encajan
 * gana uno al azar (con su peso), descartando los que tapan a alguien y penalizando los que
 * acaban de salir, para que no se vea siempre igual.
 *
 * También hay un plano de apuntar (beginAim): al elegir un objeto para empujarlo o lanzarlo,
 * encuadra a quien lo hace, el objeto y a quién puede golpear, y se queda ahí mientras se
 * elige la dirección; al ejecutar la acción pasa a ser su plano de acción.
 *
 * La cámara táctica sigue funcionando por debajo (cambio de turno incluido), así que al
 * volver se ve lo que toque. Cualquier control de cámara del jugador corta el plano.
 */
export class ActionCameraComponent extends Component {
  private shots: readonly ShotDef[] = DEFAULT_SHOTS;
  private minDistance = 4.5;
  private maxDistance = 24;
  private margin = 1.2;
  private lookHeight = 1.0;
  private blendIn = 0.45;
  private blendOut = 0.6;
  private settle = 0.2;
  private reframe = 0.35;
  private gameplayCamera = 'PlayerCamera';
  private shotsEnabled = true;
  /** Depuración: si no es null, sale siempre este plano (si encaja). */
  private forced: string | null = null;
  /** Ids de los últimos planos, el más reciente primero. */
  private recent: string[] = [];
  /** FOV (grados) de la cámara del prefab: el de los planos que no dicen otro. */
  private baseFov: number | null = null;

  private shot: Shot | null = null;
  private shakeAmount = 0;
  private shakeTime = 0;
  private shakePhase = 0;
  // Valores actuales (suavizados al reencuadrar) y los del encuadre al que se va.
  private yaw = 0;
  private targetYaw = 0;
  private pitch = 0;
  private fov = 45;
  private look = 1;
  private roll = 0;
  private distance = 0;
  private targetDistance = 0;
  private readonly center = vec3.create();
  private readonly targetCenter = vec3.create();

  private readonly tmpEye = vec3.create();
  private readonly tmpLook = vec3.create();
  private readonly tmpTestEye = vec3.create();
  private readonly tmpTestLook = vec3.create();
  private readonly tmpAim = vec3.create();
  private readonly tmpForward = vec3.create();
  private readonly tmpUp = vec3.create();

  public load(data: ActionCameraComponentDataType): void {
    this.shots = data.shots ?? this.shots;
    this.minDistance = data.minDistance ?? this.minDistance;
    this.maxDistance = data.maxDistance ?? this.maxDistance;
    this.margin = data.margin ?? this.margin;
    this.lookHeight = data.lookHeight ?? this.lookHeight;
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
    // Sigue a las unidades (empujones, caídas) sin cambiar el ángulo del plano; al
    // reencuadrar a otro plano, pasa a él suavemente.
    const k = 1 - Math.exp(-TRACK_SMOOTHING * dt);
    const def = shot.def;
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * k;
    this.pitch += (def.pitch - this.pitch) * k;
    this.fov += (this.fovOf(def) - this.fov) * k;
    this.look += (this.lookOf(def) - this.look) * k;
    this.roll += ((def.roll ?? 0) * shot.sign - this.roll) * k;
    if (this.compose(shot.source, shot.targets, this.targetYaw, def, shot.move) !== null) {
      vec3.lerp(this.center, this.center, this.targetCenter, k);
      this.distance += (this.targetDistance - this.distance) * k;
    }
    if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - dt);
    this.apply(shot.aiming ? 0 : shot.elapsed / shot.hold);
  }

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * Encuadra a `source` y a sus objetivos (unidades o puntos del suelo). Devuelve los segundos
   * que tarda la cámara en estar colocada (0 si no hay plano): la acción debe empezar entonces.
   * El plano dura `hold` segundos desde ese momento. Si ya hay uno en curso, reencuadra
   * suavemente y lo alarga.
   */
  public frameAction(
    source: Entity,
    targets: (Entity | vec3)[],
    hold: number,
    kind: ShotKind,
  ): number {
    if (!this.canShoot()) return 0;
    const choice = this.choose(source, targets, kind);
    if (!choice) return 0;

    if (!this.shot) {
      const ready = this.blendIn + this.settle;
      this.startShot(source, targets, choice, ready + hold, false);
      return ready;
    }
    this.retarget(source, targets, choice);
    // Desde el plano de apuntar: el plano de la acción empieza ahora.
    const base = this.shot.aiming ? this.shot.elapsed : this.shot.hold;
    this.shot.aiming = false;
    this.shot.hold = Math.max(base, this.shot.elapsed + this.reframe + hold);
    return this.reframe;
  }

  /**
   * Plano de apuntar: encuadra a `source` y a `targets` y se queda hasta endAim() o hasta que
   * frameAction() lo convierta en el plano de la acción. false si no hay plano.
   */
  public beginAim(source: Entity, targets: (Entity | vec3)[]): boolean {
    if (!this.canShoot()) return false;
    const choice = this.choose(source, targets, 'aim');
    if (!choice) return false;
    if (!this.shot) {
      this.startShot(source, targets, choice, Infinity, true);
      return true;
    }
    this.retarget(source, targets, choice);
    this.shot.hold = Infinity;
    this.shot.aiming = true;
    return true;
  }

  /** Termina el plano de apuntar (si lo hay; un plano de acción sigue su curso). */
  public endAim(): void {
    if (this.shot?.aiming) this.end();
  }

  public isAiming(): boolean {
    return this.shot?.aiming === true;
  }

  /** Sacude la cámara (impactos). `amount`: amplitud en m. Solo durante un plano. */
  public shake(amount: number): void {
    if (!this.shot) return;
    this.shakeAmount = Math.max(amount, this.shakeTime > 0 ? this.shakeAmount : 0);
    this.shakeTime = SHAKE_TIME;
    this.shakePhase = Math.random() * 100;
  }

  /** Alarga el plano en curso hasta `seconds` desde ahora (p.ej. para ver caer al objetivo). */
  public holdShot(seconds: number): void {
    if (this.shot) this.shot.hold = Math.max(this.shot.hold, this.shot.elapsed + seconds);
  }

  public isInShot(): boolean {
    return this.shot !== null;
  }

  /** Id del plano en curso (null si no hay). */
  public getShotId(): string | null {
    return this.shot?.def.id ?? null;
  }

  /** Depuración: fuerza un plano del catálogo (si encaja con la acción); null lo quita. */
  public forceShot(id: string | null): void {
    this.forced = id;
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
    this.shakeTime = 0;
    const gameplay = Engine.getEntities().getEntityByName(this.gameplayCamera);
    if (gameplay && Engine.getModules().getCurrentGamestate() === 'gs_gameplay') {
      Engine.getCameraMixer().blendCamera(gameplay, this.blendOut, new SmoothStepInterpolator());
    }
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private canShoot(): boolean {
    return (
      this.shotsEnabled &&
      Engine.getModules().getCurrentGamestate() === 'gs_gameplay' &&
      !CharacterSheetController.isOpen()
    );
  }

  /** Entra con un corte de encuadre: el mixer se encarga de que no se note. */
  private startShot(
    source: Entity,
    targets: (Entity | vec3)[],
    choice: Choice,
    hold: number,
    aiming: boolean,
  ): void {
    const { def, yaw } = choice;
    const move = pickMove(def);
    const sign = Math.random() < 0.5 ? -1 : 1;
    this.compose(source, targets, yaw, def, move);
    this.yaw = yaw;
    this.targetYaw = yaw;
    this.pitch = def.pitch;
    this.fov = this.fovOf(def);
    this.look = this.lookOf(def);
    this.roll = (def.roll ?? 0) * sign;
    vec3.copy(this.center, this.targetCenter);
    this.distance = this.targetDistance;
    this.shot = { source, targets, hold, elapsed: 0, aiming, def, move, sign };
    this.remember(def.id);
    this.apply(0);
    Engine.getCameraMixer().blendCamera(
      this.getOwner(),
      this.blendIn,
      new SmoothStepInterpolator(),
    );
  }

  /** Reencuadra el plano en curso (acción encadenada o de apuntar a la acción). */
  private retarget(source: Entity, targets: (Entity | vec3)[], choice: Choice): void {
    const shot = this.shot!;
    this.targetYaw = this.yaw + shortestAngle(this.yaw, choice.yaw);
    shot.source = source;
    shot.targets = targets;
    if (choice.def !== shot.def) {
      shot.def = choice.def;
      shot.move = pickMove(choice.def);
      this.remember(choice.def.id);
    }
  }

  private remember(id: string): void {
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, RECENT_PENALTY.length);
  }

  /**
   * Elige plano y lado. Candidatos: cada plano del catálogo que encaje con la acción, a cada
   * lado de la línea atacante→objetivos. Se quedan los que dejan ver a más unidades (sin muros
   * ni columnas delante, ni la cámara metida en una pared) y entre ellos gana uno al azar,
   * según su peso, lo poco que se haya visto últimamente y lo cerca que esté de la vista
   * actual (el cambio de plano se lee mejor). null si no hay dirección.
   */
  private choose(source: Entity, targets: (Entity | vec3)[], kind: ShotKind): Choice | null {
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
    const faction = (source.getComponent('unit') as UnitComponent).getFaction();
    const count = points.length - 1;

    let defs = this.shots.filter((def) => fits(def, kind, faction, count));
    const forced = defs.find((def) => def.id === this.forced);
    if (forced) defs = [forced];
    else if (defs.length === 0) defs = this.shots.slice(0, 1);

    const candidates: (Choice & { blocked: number; score: number })[] = [];
    for (const def of defs) {
      const angles = def.angle % 180 === 0 ? [def.angle] : [def.angle, -def.angle];
      for (const angle of angles) {
        const yaw = current + shortestAngle(current, along + angle);
        const needed = this.compose(source, targets, yaw, def, DEFAULT_MOVE);
        if (needed === null) continue;
        const look = this.lookOf(def);
        const eye = this.eyeFor(
          this.targetCenter,
          this.targetDistance,
          yaw,
          def.pitch,
          look,
          this.tmpTestEye,
        );
        const lookAt = vec3.set(
          this.tmpTestLook,
          this.targetCenter[0]!,
          this.targetCenter[1]! + look,
          this.targetCenter[2]!,
        );
        // Cámara detrás de una pared: peor que cualquier unidad tapada.
        let blocked = hasLineOfSight(lookAt, eye) ? 0 : points.length + 1;
        if (blocked === 0) {
          blocked = points.filter((p) => {
            const aim = vec3.set(this.tmpAim, p[0]!, p[1]! + AIM_HEIGHT, p[2]!);
            return !hasLineOfSight(eye, aim);
          }).length;
        }
        const same = this.shot?.def === def;
        const recent = this.recent.indexOf(def.id);
        const novelty = same ? CONTINUITY_BONUS : recent < 0 ? 1 : RECENT_PENALTY[recent]!;
        const closeness = 0.5 + 0.5 * (1 - Math.abs(yaw - current) / 180);
        const fit = needed <= this.maxDistance ? 1 : UNFIT_PENALTY;
        candidates.push({
          def,
          yaw,
          blocked,
          score: (def.weight ?? 1) * novelty * closeness * fit,
        });
      }
    }
    if (candidates.length === 0) return null;
    const minBlocked = Math.min(...candidates.map((c) => c.blocked));
    return weightedPick(
      candidates.filter((c) => c.blocked === minBlocked),
      (c) => c.score,
    );
  }

  /** Posición del ojo para un encuadre (centro en el suelo, distancia, yaw y pitch en grados). */
  private eyeFor(
    center: vec3,
    distance: number,
    yawDeg: number,
    pitchDeg: number,
    lookHeight: number,
    out: vec3,
  ): vec3 {
    const pitch = pitchDeg * DEG;
    const yaw = yawDeg * DEG;
    const lookY = center[1]! + lookHeight;
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

  /**
   * Centro y distancia que encuadran a todos con la vista `yaw` y el plano `def`
   * → targetCenter/targetDistance. Devuelve la distancia necesaria sin limitar (puede pasar
   * de maxDistance: entonces no caben todos), o null si no hay a quién encuadrar.
   */
  private compose(
    source: Entity,
    targets: (Entity | vec3)[],
    yaw: number,
    def: ShotDef,
    move: ShotMove,
  ): number | null {
    const points = this.collect(source, targets);
    if (points.length < 2) return null;
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
    const camera = this.getCamera();
    const tanV = Math.tan((this.fovOf(def) * DEG) / 2);
    const tanH = tanV * camera.getAspectRatio();
    const sinP = Math.abs(Math.sin(def.pitch * DEG));
    const cosP = Math.cos(def.pitch * DEG);
    let needed = 0;
    for (const p of points) {
      const r = Math.abs(-fz * p[0]! + fx * p[2]! - midR) + this.margin;
      const f = fx * p[0]! + fz * p[2]! - midF;
      const depthOffset = f * cosP; // + más lejos que el centro
      needed = Math.max(
        needed,
        r / tanH - depthOffset,
        (Math.abs(f) * sinP + this.margin) / (tanV * VERTICAL_SAFE) - depthOffset,
      );
    }
    // Que sigan cabiendo durante el movimiento (el travelling acerca la cámara, el giro y la
    // grúa cambian el encuadre).
    needed *= moveSlack(move);
    this.targetDistance = clamp(needed, this.minDistance, this.maxDistance);
    return needed;
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

  /** Coloca la cámara. `t` (0..1): progreso del plano, para su movimiento. */
  private apply(t: number): void {
    const shot = this.shot;
    if (!shot) return;
    const ease = t * t * (3 - 2 * t);
    const amount = shot.move.amount ?? 0;
    let distance = this.distance;
    let yaw = this.yaw;
    let pitch = this.pitch;
    switch (shot.move.type) {
      case 'push':
        distance *= 1 - amount * ease;
        break;
      case 'pull':
        distance *= 1 + amount * ease;
        break;
      case 'orbit':
        yaw += amount * ease * shot.sign;
        break;
      case 'crane':
        pitch += amount * ease;
        break;
      case 'static':
        break;
    }
    vec3.set(this.tmpLook, this.center[0]!, this.center[1]! + this.look, this.center[2]!);
    this.eyeFor(this.center, distance, yaw, pitch, this.look, this.tmpEye);
    if (this.shakeTime > 0) {
      // Sacudida que se apaga: senos desfasados en cada eje (ojo y punto de mira juntos).
      const k = this.shakeTime / SHAKE_TIME;
      const a = this.shakeAmount * k * k;
      const w = (SHAKE_TIME - this.shakeTime) * SHAKE_FREQUENCY * Math.PI * 2 + this.shakePhase;
      const ox = Math.sin(w) * a;
      const oy = Math.sin(w * 1.31 + 1.7) * a * 0.8;
      const oz = Math.sin(w * 0.87 + 4.1) * a;
      vec3.add(this.tmpEye, this.tmpEye, vec3.set(this.tmpAim, ox, oy, oz));
      vec3.add(this.tmpLook, this.tmpLook, this.tmpAim);
    }
    const camera = this.getCamera();
    if (Math.abs(camera.getFov() / DEG - this.fov) > 1e-3) camera.setFov(this.fov);
    camera.lookAt(this.tmpEye, this.tmpLook, this.rolledUp());
  }

  /** Vertical girada `roll` grados alrededor de la dirección de la vista (Rodrigues). */
  private rolledUp(): vec3 {
    if (Math.abs(this.roll) < 1e-3) return UP;
    const k = vec3.normalize(this.tmpForward, vec3.sub(this.tmpForward, this.tmpLook, this.tmpEye));
    const a = this.roll * DEG;
    const cos = Math.cos(a);
    const out = vec3.cross(this.tmpUp, k, UP);
    vec3.scale(out, out, Math.sin(a));
    vec3.scaleAndAdd(out, out, UP, cos);
    return vec3.scaleAndAdd(out, out, k, vec3.dot(k, UP) * (1 - cos));
  }

  private fovOf(def: ShotDef): number {
    // El del prefab, leído antes de que ningún plano lo cambie.
    this.baseFov ??= this.getCamera().getFov() / DEG;
    return def.fov ?? this.baseFov;
  }

  private lookOf(def: ShotDef): number {
    return def.lookHeight ?? this.lookHeight;
  }

  private getCamera() {
    return (this.getOwner().getComponent('camera') as CameraComponent).getCamera();
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

  /** La cámara de acción de la escena (si hay). */
  public static find(): ActionCameraComponent | null {
    const list = Engine.getEntities().getObjectManagerByName('action_camera')?.getList();
    return (list?.[0] as ActionCameraComponent | undefined) ?? null;
  }
}

/** Si el plano vale para esta acción, este bando y este número de objetivos. */
function fits(def: ShotDef, kind: ShotKind, faction: UnitFaction, count: number): boolean {
  return (
    (!def.kinds || def.kinds.includes(kind)) &&
    (!def.factions || def.factions.includes(faction)) &&
    count >= (def.minTargets ?? 1) &&
    count <= (def.maxTargets ?? Infinity)
  );
}

function pickMove(def: ShotDef): ShotMove {
  const moves = def.moves && def.moves.length > 0 ? def.moves : [DEFAULT_MOVE];
  return weightedPick(moves, (m) => m.weight ?? 1);
}

/** Cuánto más lejos hay que empezar para que el movimiento no saque a nadie del encuadre. */
function moveSlack(move: ShotMove): number {
  switch (move.type) {
    case 'push':
      return 1 / (1 - (move.amount ?? 0));
    case 'orbit':
      return 1.08;
    case 'crane':
      return 1.05;
    default:
      return 1;
  }
}

function weightedPick<T>(items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Diferencia angular más corta (grados) de `from` a `to`. */
function shortestAngle(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}
