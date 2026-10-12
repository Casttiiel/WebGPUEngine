import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { Material } from '../../../renderer/resources/Material';
import type { ColliderComponent } from '../../physics/ColliderComponent';
import { RenderComponent } from '../../render/RenderComponent';
import { UnitComponent } from './UnitComponent';
import { PartyComponent } from './PartyComponent';
import type { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import type { ActionCameraComponent } from './ActionCameraComponent';

export type CameraOccluderComponentDataType = Readonly<{
  /** Material que se usa mientras tapa la vista (p.ej. uno con tramado semitransparente). */
  fadedMaterial: string;
}>;

/** Altura (sobre el centro de la cápsula) a la que se mira a cada unidad. */
const AIM_HEIGHT = 0.3;
/** Altura sobre el pivote de la cámara (el suelo que se está mirando). */
const PIVOT_HEIGHT = 0.5;

/**
 * CameraOccluderComponent — geometría (muros, columnas) que se vuelve semitransparente
 * cuando se interpone entre la cámara y lo que hay que ver: la party, los enemigos vivos y
 * el punto al que mira la cámara (su pivote), como en BG3.
 *
 * Cada frame lanza rayos de la cámara a esas unidades (y al punto que mira el plano de acción,
 * si hay uno) contra su propio collider. Mientras
 * tapa, sus partes usan `fadedMaterial`; después vuelven a su material. Estas entidades
 * no se instancian (InstanceManager), así cada una cambia de material por separado.
 */
export class CameraOccluderComponent extends Component {
  private fadedPath = '';
  private faded: Material | null = null;
  private originals: Material[] | null = null;
  private isFaded = false;
  private loading = false;

  public load(data: CameraOccluderComponentDataType): void {
    this.fadedPath = data.fadedMaterial;
  }

  public update(_dt: number): void {
    if (!this.faded) {
      if (!this.loading && this.fadedPath) {
        this.loading = true;
        void Material.get(this.fadedPath).then((m) => (this.faded = m));
      }
      return;
    }
    this.setFaded(this.blocksView());
  }

  public isFadedOut(): boolean {
    return this.isFaded;
  }

  private blocksView(): boolean {
    const collider = (
      (this.getOwner().getComponent('box_collider') ??
        this.getOwner().getComponent('capsule_collider')) as ColliderComponent | null
    )?.getCollider();
    if (!collider) return false;
    return viewRays().some(({ ray, length }) => {
      const toi = collider.castRay(ray, length, true);
      return toi >= 0 && toi < length;
    });
  }

  private setFaded(faded: boolean): void {
    if (faded === this.isFaded) return;
    const render = this.getOwner().getComponent('render') as RenderComponent | null;
    if (!render || !this.faded) return;
    const parts = render.getParts();
    this.originals ??= parts.map((p) => p.material as Material);
    parts.forEach((_, i) => render.setPartMaterial(i, faded ? this.faded! : this.originals![i]!));
    this.isFaded = faded;
  }
}

/** Rayos de la cámara a lo que hay que ver: la party, los enemigos vivos y el pivote. */
function viewRays(): { ray: RAPIER.Ray; length: number }[] {
  const out: { ray: RAPIER.Ray; length: number }[] = [];
  const eye = Engine.getRender().getMainCamera().getPosition();
  const watch = new Set(PartyComponent.find()?.getMembers() ?? []);
  for (const u of UnitComponent.getAll()) {
    if (u.isAlive() && u.getFaction() === 'enemy') watch.add(u.getOwner());
  }
  const targets: vec3[] = [];
  for (const entity of watch) {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    if (!unit) continue;
    const p = unit.getPosition(vec3.create());
    p[1] = p[1]! + AIM_HEIGHT;
    targets.push(p);
  }
  // Durante un plano de acción se mira a su punto, no al pivote del rig táctico.
  const shotLook = (
    Engine.getEntities().getObjectManagerByName('action_camera')?.getList()[0] as
      | ActionCameraComponent
      | undefined
  )?.getLookPoint();
  const rig = Engine.getEntities()
    .getObjectManagerByName('tactical_camera_controller')
    ?.getList()[0] as TacticalCameraControllerComponent | undefined;
  if (shotLook) {
    targets.push(vec3.clone(shotLook));
  } else if (rig) {
    const pivot = vec3.clone(rig.getPivot());
    pivot[1] = pivot[1]! + PIVOT_HEIGHT;
    targets.push(pivot);
  }
  for (const p of targets) {
    const dx = p[0]! - eye[0]!;
    const dy = p[1]! - eye[1]!;
    const dz = p[2]! - eye[2]!;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-3) continue;
    out.push({
      ray: new RAPIER.Ray(
        { x: eye[0]!, y: eye[1]!, z: eye[2]! },
        { x: dx / length, y: dy / length, z: dz / length },
      ),
      length,
    });
  }
  return out;
}
