import { vec3, vec4 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { getNavMeshPositionsAndIndices } from 'recast-navigation';
import { Engine } from '../engine/Engine';
import { Time } from '../engine/Time';
import { Entity } from '../ecs/Entity';
import { Component } from '../ecs/Component';
import { DebugRenderState } from './DebugRenderState';
import { AStar } from '../../ai/nav/AStar';
import { NavMesh } from '../../ai/nav/NavMesh';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';
import { TransformComponent } from '../../components/core/TransformComponent';
import { ModuleUI } from '../../modules/core/ModuleUI';
import { PerfRecorder } from './PerfRecorder';
import { Render } from '../../renderer/core/pipeline/Render';

/**
 * DevBridge — API de depuración expuesta como `window.__engine` (solo en `npm run dev`).
 *
 * La usa el servidor MCP (tools/mcp) vía Playwright `page.evaluate()` para observar y
 * controlar el juego en ejecución. Es de solo lectura respecto al contenido: el mundo se
 * define en ficheros; aquí solo se inspecciona, se controla el tiempo/input y se consulta.
 *
 * Puntos de extensión para sistemas de juego futuros:
 *   DevBridge.registerCombatProvider({ getState, command })  → get_combat_state / game_command
 *   DevBridge.registerOverlay('ranges', () => { ...addLine... }) → debug_draw
 */

export type Vec3Like = [number, number, number];
export type PointRef = Vec3Like | string | number;

export interface DevCombatProvider {
  getState(): unknown;
  command(name: string, args: Record<string, unknown>): unknown | Promise<unknown>;
}

type Color = [number, number, number, number];

interface StepRequest {
  remaining: number;
  resolve: () => void;
}

interface FrameWaiter {
  target: number;
  resolve: () => void;
}

const MAX_ARRAY_ITEMS = 32;
const MAX_DEPTH = 3;
const PATH_OVERLAY_SECONDS = 10;

export class DevBridge {
  private static installed = false;

  // ── Tiempo ─────────────────────────────────────────────────────────────────
  private static paused = false;
  private static steps: StepRequest[] = [];
  private static fixedDelta: number | null = null;
  private static simulatedFrames = 0;
  private static renderedFrames = 0;
  private static elapsedSimTime = 0;
  private static frameWaiters: FrameWaiter[] = [];
  private static updatedThisFrame = false;
  private static lastRealDt = 1 / 60;

  // ── Estado ─────────────────────────────────────────────────────────────────
  private static seed: number | null = null;
  private static fatalError: string | null = null;
  private static readyFrame = -1;

  // ── Extensiones de juego ───────────────────────────────────────────────────
  private static combatProvider: DevCombatProvider | null = null;
  private static overlays = new Map<string, () => void>();
  private static enabledOverlays = new Set<string>();

  // ── Datos de overlays integrados ───────────────────────────────────────────
  private static navMeshEdges: Float32Array | null = null;
  private static navMeshEdgesSource: unknown = null;
  private static debugPaths: { points: Vec3Like[]; until: number; color: Color }[] = [];
  private static debugRays: { from: Vec3Like; to: Vec3Like; until: number; color: Color }[] = [];

  public static isEnabled(): boolean {
    return this.installed;
  }

  /**
   * Debe llamarse antes de Engine.start(). Aplica la semilla de la URL (`?seed=123`)
   * y publica `window.__engine`. No hace nada fuera de `dev`.
   */
  public static install(): void {
    if (!import.meta.env.DEV || this.installed) return;
    this.installed = true;

    const params = new URLSearchParams(window.location.search);
    const seedParam = params.get('seed');
    if (seedParam !== null && seedParam !== '') this.setSeed(Number(seedParam));

    this.registerBuiltinOverlays();

    (window as any).__engine = this.createApi();
  }

  public static setFatalError(error: unknown): void {
    this.fatalError =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  }

  // ── Integración con el bucle principal (main.ts) ───────────────────────────

  /**
   * Devuelve el delta a usar en Engine.update() este frame, o null para saltarse el update
   * (pausa). Gestiona step(n) y el modo de delta fijo.
   */
  public static filterDelta(dt: number): number | null {
    this.updatedThisFrame = false;
    if (!this.installed) return dt;
    this.lastRealDt = dt;

    if (this.paused) {
      const step = this.steps[0];
      if (!step) return null;
      step.remaining--;
      if (step.remaining <= 0) {
        this.steps.shift();
        step.resolve();
      }
      return this.markSimulated(this.fixedDelta ?? 1 / 60);
    }

    return this.markSimulated(
      this.fixedDelta !== null ? this.fixedDelta * Time.getTimeScale() : dt,
    );
  }

  private static markSimulated(dt: number): number {
    this.updatedThisFrame = true;
    this.simulatedFrames++;
    this.elapsedSimTime += dt;
    if (this.frameWaiters.length) {
      const pending: FrameWaiter[] = [];
      for (const w of this.frameWaiters) {
        if (this.simulatedFrames >= w.target) w.resolve();
        else pending.push(w);
      }
      this.frameWaiters = pending;
    }
    return dt;
  }

  /** Llamar justo antes de Engine.render(). Empuja las líneas de los overlays activos. */
  public static beforeRender(): void {
    if (!this.installed || !Engine.isReady()) return;
    this.renderedFrames++;
    if (this.readyFrame < 0) this.readyFrame = this.renderedFrames;

    // Si el update se ha saltado (pausa), las líneas de colliders no se han empujado.
    if (!this.updatedThisFrame) {
      const filter = DebugRenderState.getFilter();
      if (filter) Engine.getModules().pushDebugLines(filter);
    }

    for (const name of this.enabledOverlays) {
      const draw = this.overlays.get(name);
      if (!draw) continue;
      try {
        draw();
      } catch (e) {
        console.error(`[DevBridge] overlay '${name}' failed`, e);
        this.enabledOverlays.delete(name);
      }
    }
  }

  // ── Extensiones ────────────────────────────────────────────────────────────

  public static registerCombatProvider(provider: DevCombatProvider | null): void {
    this.combatProvider = provider;
  }

  public static registerOverlay(name: string, draw: () => void): void {
    this.overlays.set(name, draw);
  }

  // ── Semilla ────────────────────────────────────────────────────────────────

  public static setSeed(seed: number): void {
    if (!Number.isFinite(seed)) throw new Error(`Invalid seed: ${seed}`);
    this.seed = seed >>> 0;
    // mulberry32: rápido, 32 bits de estado, suficiente para gameplay reproducible.
    let state = this.seed;
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── API pública (window.__engine) ──────────────────────────────────────────

  private static createApi(): Record<string, unknown> {
    return {
      isReady: () => this.isReady(),
      getStatus: () => this.getStatus(),

      // Frame-by-frame performance capture (stutter diagnosis)
      perfStart: () => PerfRecorder.start(),
      perfStop: () => PerfRecorder.stop(),
      perfCapture: (seconds?: number) => PerfRecorder.capture(seconds ?? 5),
      setMaxFramesInFlight: (n: number) => {
        Render.setMaxFramesInFlight(n);
        return Render.getMaxFramesInFlight();
      },

      listEntities: (opts?: {
        name?: string;
        component?: string;
        limit?: number;
        includePool?: boolean;
      }) => this.listEntities(opts ?? {}),
      getEntity: (ref: string | number, components?: string[]) => this.getEntity(ref, components),

      pause: () => this.setPaused(true),
      resume: () => this.setPaused(false),
      step: (frames?: number) => this.step(frames ?? 1),
      setTimeScale: (scale: number) => {
        Time.setTimeScale(scale);
        return this.getTimeState();
      },
      setFixedDelta: (dt: number | null) => {
        this.fixedDelta = dt !== null && dt > 0 ? dt : null;
        return this.getTimeState();
      },
      getTimeState: () => this.getTimeState(),
      waitFrames: (frames: number, timeoutMs?: number) =>
        this.waitFrames(frames, timeoutMs ?? 30000),
      setSeed: (seed: number) => {
        this.setSeed(seed);
        return { seed: this.seed };
      },

      worldToScreen: (pos: PointRef) => this.worldToScreen(this.resolvePoint(pos)),
      getWidgetRect: (alias: string) => this.getWidgetRect(alias),
      queryPath: (from: PointRef, to: PointRef) => this.queryPath(from, to),
      queryLos: (from: PointRef, to: PointRef, eyeHeight?: number) =>
        this.queryLos(from, to, eyeHeight ?? 1.5),

      setDebugDraw: (opts: Record<string, boolean>) => this.setDebugDraw(opts),
      getDebugDraw: () => this.getDebugDraw(),

      getCombatState: () => {
        if (!this.combatProvider)
          throw new Error('No combat provider registered (llega en la Fase 3: turnos)');
        return this.toJSONSafe(this.combatProvider.getState(), 0, new WeakSet(), 6);
      },
      gameCommand: async (name: string, args?: Record<string, unknown>) => {
        if (!this.combatProvider)
          throw new Error('No combat provider registered (llega en la Fase 3: turnos)');
        const result = await this.combatProvider.command(name, args ?? {});
        return this.toJSONSafe(result, 0, new WeakSet(), 6);
      },

      /** Serializa cualquier valor de forma segura (sin ciclos ni handles GPU). Usado por `eval`. */
      serialize: (value: unknown) => this.toJSONSafe(value, 0, new WeakSet(), 4),

      /** Lee un valor por ruta "componente.campo.sub" de una entidad. Usado por los asserts. */
      readPath: (ref: string | number, path: string) => this.readPath(ref, path),
    };
  }

  private static isReady(): boolean {
    return Engine.isReady() && this.readyFrame > 0 && this.renderedFrames - this.readyFrame >= 2;
  }

  private static getStatus(): Record<string, unknown> {
    const ready = this.isReady();
    const status: Record<string, unknown> = {
      ready,
      fatalError: this.fatalError,
      fps: Math.round(1 / Math.max(this.lastRealDt, 1e-4)),
      seed: this.seed,
      time: this.getTimeState(),
      url: window.location.href,
      canvas: this.getCanvasSize(),
    };
    if (ready) {
      const modules = Engine.getModules();
      status.gamestate = modules.getCurrentGamestate();
      status.entityCount = Engine.getEntities().getAllEntities().length;
      status.navMeshBuilt = NavMesh.getInstance().isBuilt();
      status.combatProvider = this.combatProvider !== null;
      status.overlays = this.getDebugDraw();
    }
    return status;
  }

  private static getCanvasSize(): { width: number; height: number } | null {
    const canvas = document.getElementById('gfx-canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  }

  // ── Entidades ──────────────────────────────────────────────────────────────

  private static summarize(entity: Entity): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      id: entity.id,
      name: entity.getName(),
      components: entity.getComponentEntries().map(([name]) => name),
    };
    const parent = entity.getParent();
    if (parent) summary.parent = parent.id;
    if (entity.getChildren().length) summary.children = entity.getChildren().length;
    const pos = this.getEntityPosition(entity);
    if (pos) summary.position = pos;
    return summary;
  }

  private static listEntities(opts: {
    name?: string;
    component?: string;
    limit?: number;
    includePool?: boolean;
  }): { total: number; returned: number; entities: Record<string, unknown>[] } {
    const needle = opts.name?.toLowerCase();
    const matches = Engine.getEntities()
      .getAllEntities()
      .filter((e) => opts.includePool || !e.isPoolEntity)
      .filter((e) => !needle || e.getName().toLowerCase().includes(needle))
      .filter((e) => !opts.component || e.hasComponent(opts.component));
    const limited = matches.slice(0, opts.limit ?? 200);
    return {
      total: matches.length,
      returned: limited.length,
      entities: limited.map((e) => this.summarize(e)),
    };
  }

  private static findEntity(ref: string | number): Entity {
    const entities = Engine.getEntities();
    const entity =
      typeof ref === 'number' || /^\d+$/.test(ref)
        ? entities.getEntityById(Number(ref))
        : entities.getEntityByName(ref);
    if (!entity) throw new Error(`Entity not found: ${ref}`);
    return entity;
  }

  private static getEntity(ref: string | number, only?: string[]): Record<string, unknown> {
    const entity = this.findEntity(ref);
    const components: Record<string, unknown> = {};
    for (const [name, comp] of entity.getComponentEntries()) {
      if (only && only.length && !only.includes(name)) continue;
      components[name] = this.serializeComponent(comp);
    }
    return {
      ...this.summarize(entity),
      childEntities: entity.getChildren().map((c) => ({ id: c.id, name: c.getName() })),
      componentData: components,
    };
  }

  private static readPath(ref: string | number, path: string): unknown {
    const entity = this.findEntity(ref);
    const [compName, ...rest] = path.split('.');
    if (!compName) throw new Error('Empty path');
    if (compName === 'position') return this.getEntityPosition(entity);
    const comp = entity.getComponent(compName);
    if (!comp) throw new Error(`Entity '${entity.getName()}' has no component '${compName}'`);

    let value: any = comp;
    for (const key of rest) {
      if (value === null || value === undefined) break;
      const next = value[key];
      // Permite rutas a getters sin argumentos: "health.getCurrentHp"
      value = typeof next === 'function' ? next.call(value) : next;
    }
    return this.toJSONSafe(value, 0, new WeakSet(), MAX_DEPTH);
  }

  private static getEntityPosition(entity: Entity): Vec3Like | null {
    const transform = entity.getComponent('transform') as TransformComponent | null;
    if (!transform) return null;
    const p = transform.getTransform().getWorldPosition();
    return [round(p[0]!), round(p[1]!), round(p[2]!)];
  }

  private static serializeComponent(comp: Component): Record<string, unknown> {
    const out: Record<string, unknown> = { $class: comp.constructor.name };
    const seen = new WeakSet<object>([comp]);
    for (const key of Object.keys(comp)) {
      if (key.startsWith('_editor') || key === 'owner') continue;

      const value = (comp as any)[key];
      if (typeof value === 'function') continue;
      out[key] = this.toJSONSafe(value, 1, seen, MAX_DEPTH);
    }
    return out;
  }

  /** Convierte cualquier valor a algo serializable sin ciclos, GPU handles ni objetos gigantes. */
  private static toJSONSafe(
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
    maxDepth: number,
  ): unknown {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'number') return Number.isFinite(value) ? round(value) : String(value);
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object') return String(value);

    if (ArrayBuffer.isView(value)) {
      const arr = value as unknown as ArrayLike<number>;
      if (arr.length <= 16) return Array.from(arr, (n) => round(Number(n)));
      return `[${value.constructor.name} length=${arr.length}]`;
    }
    if (value instanceof Entity) return { $entity: value.getName(), id: value.id };
    if (value instanceof Component) return `[${value.constructor.name}]`;
    if (value instanceof HTMLElement) return `[${value.tagName}]`;

    const ctorName = (value as object).constructor?.name ?? 'Object';
    if (ctorName.startsWith('GPU')) return `[${ctorName}]`;
    if (seen.has(value)) return '[Circular]';
    if (depth >= maxDepth) return `[${ctorName}]`;
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((v) => this.toJSONSafe(v, depth + 1, seen, maxDepth));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`…(+${value.length - MAX_ARRAY_ITEMS})`);
      return items;
    }
    if (value instanceof Map) {
      const obj: Record<string, unknown> = { $map: value.size };
      let i = 0;
      for (const [k, v] of value) {
        if (i++ >= MAX_ARRAY_ITEMS) break;
        obj[String(k)] = this.toJSONSafe(v, depth + 1, seen, maxDepth);
      }
      return obj;
    }
    if (value instanceof Set) {
      return {
        $set: value.size,
        values: this.toJSONSafe(Array.from(value), depth + 1, seen, maxDepth),
      };
    }

    const isPlain = ctorName === 'Object';
    // Instancias de clases ajenas (Rapier, Camera, Material…) solo se expanden un nivel.
    if (!isPlain && depth >= 2) return `[${ctorName}]`;
    const obj: Record<string, unknown> = isPlain ? {} : { $class: ctorName };
    for (const key of Object.keys(value)) {
      const v = (value as any)[key];
      if (typeof v === 'function') continue;
      obj[key] = this.toJSONSafe(v, depth + 1, seen, maxDepth);
    }
    return obj;
  }

  // ── Tiempo ─────────────────────────────────────────────────────────────────

  private static getTimeState(): Record<string, unknown> {
    return {
      paused: this.paused,
      pendingSteps: this.steps.reduce((n, s) => n + s.remaining, 0),
      timeScale: Time.getTimeScale(),
      fixedDelta: this.fixedDelta,
      simulatedFrames: this.simulatedFrames,
      simulatedSeconds: round(this.elapsedSimTime),
    };
  }

  private static setPaused(paused: boolean): Record<string, unknown> {
    this.paused = paused;
    if (!paused) {
      for (const s of this.steps) s.resolve();
      this.steps = [];
    }
    return this.getTimeState();
  }

  private static step(frames: number): Promise<Record<string, unknown>> {
    this.paused = true;
    const n = Math.max(1, Math.floor(frames));
    return new Promise((resolve) => {
      this.steps.push({ remaining: n, resolve: () => resolve(this.getTimeState()) });
    });
  }

  private static waitFrames(frames: number, timeoutMs: number): Promise<Record<string, unknown>> {
    const target = this.simulatedFrames + Math.max(1, Math.floor(frames));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`waitFrames timed out after ${timeoutMs}ms (paused=${this.paused})`)),
        timeoutMs,
      );
      this.frameWaiters.push({
        target,
        resolve: () => {
          clearTimeout(timer);
          resolve(this.getTimeState());
        },
      });
    });
  }

  // ── Consultas espaciales ───────────────────────────────────────────────────

  private static resolvePoint(ref: PointRef): vec3 {
    if (Array.isArray(ref)) return vec3.fromValues(ref[0], ref[1], ref[2]);
    const pos = this.getEntityPosition(this.findEntity(ref));
    if (!pos) throw new Error(`Entity '${ref}' has no transform`);
    return vec3.fromValues(pos[0], pos[1], pos[2]);
  }

  private static worldToScreen(p: vec3): { x: number; y: number; visible: boolean } {
    const camera = Engine.getRender().getMainCamera();
    const clip = vec4.fromValues(p[0]!, p[1]!, p[2]!, 1);
    vec4.transformMat4(clip, clip, camera.getUnjitteredViewProjection());
    const w = clip[3]!;
    const size = this.getCanvasSize() ?? { width: window.innerWidth, height: window.innerHeight };
    if (w <= 1e-6) return { x: -1, y: -1, visible: false };
    const nx = clip[0]! / w;
    const ny = clip[1]! / w;
    const x = (nx * 0.5 + 0.5) * size.width;
    const y = (1 - (ny * 0.5 + 0.5)) * size.height;
    const visible = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
    return { x: round(x), y: round(y), visible };
  }

  /** Rectángulo de un widget de UI (por alias o nombre) en px CSS relativos al canvas. */
  private static getWidgetRect(alias: string): Record<string, unknown> {
    const ui = ModuleUI.getInstance();
    const widget = ui?.getWidgetByAlias(alias) ?? ui?.getWidgetByName(alias);
    if (!widget) throw new Error(`Widget not found: ${alias}`);
    const dpr = window.devicePixelRatio || 1;
    const [ox, oy] = widget.getOrigin();
    const size = widget.getSize();
    return {
      x: round(ox / dpr),
      y: round(oy / dpr),
      width: round(size[0]! / dpr),
      height: round(size[1]! / dpr),
      visible: widget.isVisible(),
    };
  }

  private static queryPath(fromRef: PointRef, toRef: PointRef): Record<string, unknown> {
    if (!NavMesh.getInstance().isBuilt()) throw new Error('NavMesh not built in this scene');
    const from = this.resolvePoint(fromRef);
    const to = this.resolvePoint(toRef);
    const path = AStar.findPath(from, to);
    if (!path) return { reachable: false, from: toVec3Like(from), to: toVec3Like(to) };

    let length = 0;
    for (let i = 1; i < path.length; i++) length += vec3.distance(path[i - 1]!, path[i]!);
    const points = path.map(toVec3Like);
    const end = path[path.length - 1]!;
    // Detour devuelve un camino parcial si el destino no es alcanzable: lo detectamos por distancia.
    const endGap = vec3.distance(end, to);
    this.debugPaths.push({
      points,
      until: performance.now() + PATH_OVERLAY_SECONDS * 1000,
      color: [0, 0.8, 1, 1],
    });
    return {
      reachable: endGap < 0.5,
      length: round(length),
      endGapToTarget: round(endGap),
      points,
    };
  }

  private static queryLos(
    fromRef: PointRef,
    toRef: PointRef,
    eyeHeight: number,
  ): Record<string, unknown> {
    const physics = Engine.getPhysics();
    const fromEntity =
      typeof fromRef === 'string' || typeof fromRef === 'number' ? this.findEntity(fromRef) : null;
    const toEntity =
      typeof toRef === 'string' || typeof toRef === 'number' ? this.findEntity(toRef) : null;
    const from = this.resolvePoint(fromRef);
    const to = this.resolvePoint(toRef);
    // Para entidades, mirar desde/hacia la altura de los ojos en lugar del pivote.
    if (fromEntity) from[1]! += eyeHeight;
    if (toEntity) to[1]! += eyeHeight;

    const dir = vec3.sub(vec3.create(), to, from);
    const distance = vec3.length(dir);
    if (distance < 1e-4) return { visible: true, distance: 0 };
    vec3.scale(dir, dir, 1 / distance);

    const ignored = new Set<number>();
    if (fromEntity) collectIds(fromEntity, ignored);
    const targetIds = new Set<number>();
    if (toEntity) collectIds(toEntity, targetIds);

    const ray = new RAPIER.Ray(
      { x: from[0]!, y: from[1]!, z: from[2]! },
      { x: dir[0]!, y: dir[1]!, z: dir[2]! },
    );
    const hit = physics
      .getWorld()
      .castRay(ray, distance, true, undefined, undefined, undefined, undefined, (collider) => {
        if (collider.isSensor()) return false;
        const id = physics.getEntityIdFromCollider(collider.handle);
        return id === undefined || !ignored.has(id);
      });

    let visible = true;
    let blocker: Record<string, unknown> | null = null;
    const hitDistance = hit ? hit.timeOfImpact : distance;
    if (hit) {
      const id = physics.getEntityIdFromCollider(hit.collider.handle);
      const isTarget = id !== undefined && targetIds.has(id);
      if (!isTarget && hit.timeOfImpact < distance - 0.05) {
        visible = false;
        const blockerEntity = id !== undefined ? Engine.getEntities().getEntityById(id) : null;
        blocker = {
          entity: blockerEntity ? { id: blockerEntity.id, name: blockerEntity.getName() } : null,
          distance: round(hit.timeOfImpact),
          point: toVec3Like(vec3.scaleAndAdd(vec3.create(), from, dir, hit.timeOfImpact)),
        };
      }
    }

    const until = performance.now() + PATH_OVERLAY_SECONDS * 1000;
    const end = toVec3Like(
      vec3.scaleAndAdd(vec3.create(), from, dir, visible ? distance : hitDistance),
    );
    this.debugRays.push({
      from: toVec3Like(from),
      to: end,
      until,
      color: visible ? [0, 1, 0, 1] : [1, 0, 0, 1],
    });
    return {
      visible,
      distance: round(distance),
      from: toVec3Like(from),
      to: toVec3Like(to),
      blocker,
    };
  }

  // ── Debug draw ─────────────────────────────────────────────────────────────

  private static registerBuiltinOverlays(): void {
    this.overlays.set('navmesh', () => this.drawNavMesh());
    this.overlays.set('paths', () => this.drawPaths());
    this.overlays.set('los', () => this.drawRays());
  }

  private static getDebugDraw(): Record<string, boolean> {
    const state: Record<string, boolean> = {
      colliders: DebugRenderState.showColliders,
      sensors: DebugRenderState.showSensors,
      lights: DebugRenderState.showLights,
      cameras: DebugRenderState.showCameras,
    };
    for (const name of this.overlays.keys()) state[name] = this.enabledOverlays.has(name);
    return state;
  }

  private static setDebugDraw(opts: Record<string, boolean>): Record<string, boolean> {
    for (const [key, on] of Object.entries(opts)) {
      switch (key) {
        case 'colliders':
          DebugRenderState.showColliders = on;
          break;
        case 'sensors':
          DebugRenderState.showSensors = on;
          break;
        case 'lights':
          DebugRenderState.showLights = on;
          break;
        case 'cameras':
          DebugRenderState.showCameras = on;
          break;
        default:
          if (!this.overlays.has(key)) {
            throw new Error(
              `Unknown overlay '${key}'. Available: ${Object.keys(this.getDebugDraw()).join(', ')}`,
            );
          }
          if (on) this.enabledOverlays.add(key);
          else this.enabledOverlays.delete(key);
      }
    }
    return this.getDebugDraw();
  }

  private static drawNavMesh(): void {
    const recast = NavMesh.getInstance().getRecastNavMesh();
    if (!recast) return;
    // Si el navmesh se ha reconstruido, recalcular las aristas.
    const version = NavMesh.getInstance().getVersion();
    if (this.navMeshEdgesSource !== version) {
      this.navMeshEdges = null;
      this.navMeshEdgesSource = version;
    }
    if (!this.navMeshEdges) {
      const [positions, indices] = getNavMeshPositionsAndIndices(recast);
      const edges: number[] = [];
      const seen = new Set<string>();
      const lift = 0.05; // evita z-fighting con el suelo
      for (let t = 0; t + 2 < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = indices[t + e]!;
          const b = indices[t + ((e + 1) % 3)]!;
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push(
            positions[a * 3]!,
            positions[a * 3 + 1]! + lift,
            positions[a * 3 + 2]!,
            positions[b * 3]!,
            positions[b * 3 + 1]! + lift,
            positions[b * 3 + 2]!,
          );
        }
      }
      this.navMeshEdges = new Float32Array(edges);
    }
    const drawer = PhysicsDebugDrawer.getInstance();
    const e = this.navMeshEdges;
    const col: Color = [0.2, 0.6, 1.0, 1.0];
    for (let i = 0; i + 5 < e.length; i += 6) {
      drawer.addLine(e[i]!, e[i + 1]!, e[i + 2]!, e[i + 3]!, e[i + 4]!, e[i + 5]!, col);
    }
  }

  private static drawPaths(): void {
    const now = performance.now();
    this.debugPaths = this.debugPaths.filter((p) => p.until > now);
    const drawer = PhysicsDebugDrawer.getInstance();
    for (const path of this.debugPaths) {
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!;
        const b = path.points[i]!;
        drawer.addLine(a[0], a[1] + 0.1, a[2], b[0], b[1] + 0.1, b[2], path.color);
      }
    }
  }

  private static drawRays(): void {
    const now = performance.now();
    this.debugRays = this.debugRays.filter((r) => r.until > now);
    const drawer = PhysicsDebugDrawer.getInstance();
    for (const r of this.debugRays) {
      drawer.addLine(r.from[0], r.from[1], r.from[2], r.to[0], r.to[1], r.to[2], r.color);
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function toVec3Like(v: vec3): Vec3Like {
  return [round(v[0]!), round(v[1]!), round(v[2]!)];
}

function collectIds(entity: Entity, out: Set<number>): void {
  out.add(entity.id);
  for (const child of entity.getChildren()) collectIds(child, out);
}
