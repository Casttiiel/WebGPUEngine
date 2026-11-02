import { AnimatorComponent } from '../../components/render/AnimatorComponent';
import { AnimSequenceStep } from '../../components/render/AnimSequenceComponent';
import { Engine } from '../engine/Engine';
import { ResourceManager } from '../engine/ResourceManager';
import { Loader } from '../loaders/Loader';
import { Logger } from './Logger';
import { EntityDataType } from '../../types/SceneData.type';

/**
 * Dev: `?animLoop=Spear_Thrust` makes every animated character in the scene loop that clip
 * (moving with its root motion, back to the start each pass) and hands it the clip's weapon;
 * `?animLoop=Spear_Combo` chains every clip of the set at its cancel point (`Spear_Combo_Heavy`:
 * the clips retimed with the heavy tempo profile).
 * Clips and their events come from tools/anim (see tools/anim/build.mjs).
 */
const SETS: Record<string, { file: string; events: string; weapon: string }> = {
  Spear: {
    file: 'spear_combat.gltf',
    events: 'assets/animations/spear_combat.json',
    weapon: 'weapons/spear.prefab',
  },
  Greatsword: {
    file: 'greatsword_combat.gltf',
    events: 'assets/animations/greatsword_combat.json',
    weapon: 'weapons/greatsword.prefab',
  },
};

interface ClipEvents {
  name: string;
  tempo: string;
  hit: number;
  cancel: number;
  /** Pose a chained attack starts from (where the previous hit left the weapon). */
  entry?: number;
}

export async function applyAnimLoopPreview(param: string): Promise<void> {
  const setName = param.split('_')[0]!;
  const set = SETS[setName];
  if (!set) {
    Logger.warn('ENGINE', `animLoop: unknown animation set for '${param}'`);
    return;
  }
  const events = (await (await ResourceManager.fetch(set.events)).json()) as {
    clips: ClipEvents[];
  };
  const combo = param.startsWith(`${setName}_Combo`);
  // `<Set>_Combo` uses the set's first (authored) tempo, `<Set>_Combo_Heavy` another one
  const tempo =
    param.slice(`${setName}_Combo_`.length).toLowerCase() || events.clips[0]?.tempo || '';
  const clips = combo
    ? events.clips.filter((c) => c.tempo === tempo)
    : events.clips.filter((c) => c.name === param);
  if (clips.length === 0) {
    Logger.warn('ENGINE', `animLoop: no clip '${param}' in ${set.file}`);
    return;
  }
  // Chain at the cancel points, each next hit entering at its entry pose; the last clip plays
  // out to the guard
  const steps: AnimSequenceStep[] = clips.map((c, i) => ({
    clip: c.name,
    ...(i < clips.length - 1 ? { next: c.cancel } : {}),
    ...(i > 0 && c.entry ? { from: c.entry } : {}),
  }));

  const entities = Engine.getEntities()
    .getAllEntities()
    // anim_lab's TargetDummy stays the target
    .filter((e) => e.getComponent('animator') && e.getName() !== 'TargetDummy');
  await Promise.all(
    entities.map(async (entity) => {
      const animator = entity.getComponent('animator') as AnimatorComponent;
      if (!animator.hasClip(clips[0]!.name)) await animator.loadAnimations([set.file]);
      await Loader.loadComponentFromJSON(
        { components: { anim_sequence: { steps, pause: combo ? 0.8 : 0.35 } } } as EntityDataType,
        entity,
      );
      await Loader.spawnFromJSON({ prefab: set.weapon } as EntityDataType, entity);
    }),
  );
  Logger.info('ENGINE', `animLoop: ${entities.length} characters playing '${param}'`);
}
