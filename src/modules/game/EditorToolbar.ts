import GUI from 'lil-gui';
import { Time } from '../../core/engine/Time';
import { DebugRenderState } from '../../core/debug/DebugRenderState';
import { ProfilerOverlay } from '../../core/debug/ProfilerOverlay';

type EditorListKind = 'scenes' | 'scenarios' | 'prefabs';

/** Ficheros de assets que lista el servidor de desarrollo (vite.config.ts → editor-list). */
export async function fetchEditorList(kind: EditorListKind): Promise<string[]> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}__editor/list?kind=${kind}`);
    if (!response.ok) return [];
    return (await response.json()) as string[];
  } catch {
    return [];
  }
}

const SPEEDS: Record<string, number> = {
  'Pause': 0,
  '0.1x  Bullet Time': 0.1,
  '0.25x': 0.25,
  '0.5x': 0.5,
  '1x  Normal': 1,
  '2x  Fast': 2,
};

/**
 * Barra de herramientas del F2: escena / escenario (recarga la página con ?scene= /
 * ?scenario=), velocidad del tiempo y overlays de depuración (los mismos que F1, F3–F6).
 */
export class EditorToolbar {
  public static async build(folder: GUI): Promise<void> {
    const [scenes, scenarios] = await Promise.all([fetchEditorList('scenes'), fetchEditorList('scenarios')]);

    // ── Escena / escenario ──
    const params = new URLSearchParams(window.location.search);
    const current = { scene: params.get('scene') ?? '', scenario: params.get('scenario') ?? '' };
    const sceneOptions: Record<string, string> = { '(boot.json)': '' };
    for (const s of scenes) sceneOptions[s.replace(/\.json$/, '')] = s;
    if (current.scene && !Object.values(sceneOptions).includes(current.scene)) sceneOptions[current.scene] = current.scene;
    const scenarioOptions: Record<string, string> = { '(none)': '' };
    for (const s of scenarios) scenarioOptions[s.replace(/\.json$/, '')] = s.replace(/\.json$/, '');

    folder
      .add(current, 'scene', sceneOptions)
      .name('Scene')
      .onChange((v: string) => this.navigate({ scene: v, scenario: '' }));
    folder
      .add(current, 'scenario', scenarioOptions)
      .name('Scenario')
      .onChange((v: string) => this.navigate({ scenario: v, scene: '' }));
    folder.add({ fn: () => window.location.reload() }, 'fn').name('Reload');

    // ── Tiempo ──
    const time = {} as { timeScale: number };
    Object.defineProperty(time, 'timeScale', {
      get: () => Time.getTimeScale(),
      set: (v: number) => Time.setTimeScale(v),
      enumerable: true,
      configurable: true,
    });
    folder.add(time, 'timeScale', SPEEDS).name('Speed').listen();
    folder.add(time, 'timeScale', 0, 3, 0.01).name('Time Scale').listen();

    // ── Overlays ──
    const overlays = folder.addFolder('Overlays');
    overlays.close();
    const profiler = {} as { visible: boolean };
    Object.defineProperty(profiler, 'visible', {
      get: () => ProfilerOverlay.isVisible(),
      set: (v: boolean) => {
        if (v !== ProfilerOverlay.isVisible()) ProfilerOverlay.toggle();
      },
      enumerable: true,
      configurable: true,
    });
    overlays.add(profiler, 'visible').name('Profiler (F1)').listen();
    overlays.add(DebugRenderState, 'showColliders').name('Colliders (F3)').listen();
    overlays.add(DebugRenderState, 'showSensors').name('Sensors (F4)').listen();
    overlays.add(DebugRenderState, 'showLights').name('Lights (F5)').listen();
    overlays.add(DebugRenderState, 'showCameras').name('Cameras (F6)').listen();
    overlays.add({ keys: 'F7 probe · F8 bake · F9 GI mode' }, 'keys').name('Keys').disable();
  }

  /** Recarga con otra escena o escenario (el resto de parámetros de la URL se conserva). */
  private static navigate(change: { scene: string; scenario: string }): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(change)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.location.assign(url.toString());
  }
}
