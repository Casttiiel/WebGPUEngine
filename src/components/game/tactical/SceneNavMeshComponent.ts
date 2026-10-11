import { quat, vec3 } from 'gl-matrix';
import { ShapeType } from '@dimforge/rapier3d';
import type { Collider, Cuboid, TriMesh } from '@dimforge/rapier3d';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { NavMeshBuilder } from '../../../ai/nav/NavMeshBuilder';
import { Logger } from '../../../core/debug/Logger';

export type SceneNavMeshComponentDataType = Readonly<{
  /** Tamaño de celda horizontal (m). Menor = más preciso alrededor de obstáculos. */
  cellSize?: number;
  /** Tamaño de celda vertical (m). */
  cellHeight?: number;
  /** Radio del agente (m): el navmesh se separa esto de paredes y obstáculos. */
  agentRadius?: number;
  /** Altura libre mínima (m) para que un punto sea transitable. */
  agentHeight?: number;
  /** Escalón máximo que se puede subir (m). */
  agentMaxClimb?: number;
  /** Pendiente máxima transitable (grados). */
  agentMaxSlope?: number;
  /** Entidades (por nombre) cuyos colliders no cuentan como geometría. */
  exclude?: string[];
}>;

/**
 * SceneNavMeshComponent — genera el navmesh a partir de los colliders estáticos de la
 * escena (cajas y trimeshes de cuerpos fijos). Así una escena montada con primitivas en
 * JSON tiene pathfinding sin necesidad de un nodo "navmesh" en un GLTF.
 *
 * Las unidades (cuerpos kinematic/dinámicos) y los sensores no cuentan como obstáculos:
 * el navmesh es el mapa estático; los obstáculos dinámicos se resuelven más adelante.
 */
export class SceneNavMeshComponent extends Component {
  private cellSize = 0.15;
  private cellHeight = 0.1;
  private agentRadius = 0.4;
  private agentHeight = 1.8;
  private agentMaxClimb = 0.35;
  private agentMaxSlope = 40;
  private exclude = new Set<string>();
  private requested = false;

  public load(data: SceneNavMeshComponentDataType): void {
    this.cellSize = data.cellSize ?? this.cellSize;
    this.cellHeight = data.cellHeight ?? this.cellHeight;
    this.agentRadius = data.agentRadius ?? this.agentRadius;
    this.agentHeight = data.agentHeight ?? this.agentHeight;
    this.agentMaxClimb = data.agentMaxClimb ?? this.agentMaxClimb;
    this.agentMaxSlope = data.agentMaxSlope ?? this.agentMaxSlope;
    this.exclude = new Set(data.exclude ?? []);
  }

  /** Se construye en el primer update: para entonces toda la escena y su física están cargadas. */
  public update(_dt: number): void {
    if (this.requested) return;
    this.requested = true;
    this.build().catch((e) => console.error('[SceneNavMesh] build failed', e));
  }

  public async build(): Promise<void> {
    const t0 = performance.now();
    const { positions, indices, colliders } = this.collectGeometry();
    if (!indices.length) {
      Logger.warn('ENGINE', '[SceneNavMesh] No static colliders found — navmesh not built');
      return;
    }
    await NavMeshBuilder.build(new Float32Array(positions), new Uint32Array(indices), undefined, {
      cs: this.cellSize,
      ch: this.cellHeight,
      walkableRadius: Math.ceil(this.agentRadius / this.cellSize),
      walkableHeight: Math.ceil(this.agentHeight / this.cellHeight),
      walkableClimb: Math.floor(this.agentMaxClimb / this.cellHeight),
      walkableSlopeAngle: this.agentMaxSlope,
    });
    Logger.info(
      'ENGINE',
      `[SceneNavMesh] Built from ${colliders} static colliders (${indices.length / 3} tris) in ${(performance.now() - t0).toFixed(0)}ms`,
    );
  }

  private collectGeometry(): { positions: number[]; indices: number[]; colliders: number } {
    const physics = Engine.getPhysics();
    const positions: number[] = [];
    const indices: number[] = [];
    let colliders = 0;

    physics.getWorld().forEachCollider((collider: Collider) => {
      if (collider.isSensor()) return;
      const body = collider.parent();
      if (body && !body.isFixed()) return;
      const entityId = physics.getEntityIdFromCollider(collider.handle);
      const entity = entityId !== undefined ? Engine.getEntities().getEntityById(entityId) : null;
      if (entity && this.exclude.has(entity.getName())) return;

      const t = collider.translation();
      const r = collider.rotation();
      const pos = vec3.fromValues(t.x, t.y, t.z);
      const rot = quat.fromValues(r.x, r.y, r.z, r.w);

      if (collider.shape.type === ShapeType.Cuboid) {
        const he = (collider.shape as Cuboid).halfExtents;
        appendBox(positions, indices, pos, rot, he.x, he.y, he.z);
        colliders++;
      } else if (collider.shape.type === ShapeType.TriMesh) {
        const mesh = collider.shape as TriMesh;
        const base = positions.length / 3;
        const v = vec3.create();
        for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
          vec3.set(v, mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!);
          vec3.transformQuat(v, v, rot);
          vec3.add(v, v, pos);
          positions.push(v[0]!, v[1]!, v[2]!);
        }
        for (const idx of mesh.indices) indices.push(base + idx);
        colliders++;
      }
    });

    return { positions, indices, colliders };
  }
}

/** Añade una caja orientada (12 triángulos, normales hacia fuera). */
function appendBox(
  positions: number[],
  indices: number[],
  center: vec3,
  rotation: quat,
  hx: number,
  hy: number,
  hz: number,
): void {
  const base = positions.length / 3;
  const v = vec3.create();
  for (let i = 0; i < 8; i++) {
    vec3.set(v, i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);
    vec3.transformQuat(v, v, rotation);
    vec3.add(v, v, center);
    positions.push(v[0]!, v[1]!, v[2]!);
  }
  // Caras: -X, +X, -Y, +Y, -Z, +Z (índices de esquina con bits x=1, y=2, z=4)
  const faces = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];
  for (const [a, b, c, d] of faces) {
    indices.push(base + a!, base + b!, base + c!, base + a!, base + c!, base + d!);
  }
}
