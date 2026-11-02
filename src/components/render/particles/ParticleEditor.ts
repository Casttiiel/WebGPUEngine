import type { ParticleSystemComponent } from '../ParticleSystemComponent';
import {
  FACINGS,
  FLIPBOOK_MODES,
  RENDERERS,
  SPAWN_SHAPES,
  clampSegments,
  particleConfigToData,
} from './ParticleConfig';

/** Materiales de partículas disponibles en el desplegable (técnica = blending / iluminación). */
const PARTICLE_MATERIALS = [
  'particle_worldspace.mat', // aditivo
  'particle_alpha.mat', // alpha (humo oscuro, polvo)
  'particle_smoke.mat', // alpha con flipbook de humo 4×4
  'particle_ash.mat', // alpha iluminado (sol, sombras, probes, niebla)
  'particle_blood.mat', // sangre (gota / neblina)
  'rain_particle.mat',
];

type Folder = any;

const AXES = ['x', 'y', 'z'];

function addVec3(
  folder: Folder,
  v: number[],
  label: string,
  min: number,
  max: number,
  step: number,
  onChange?: () => void,
): void {
  AXES.forEach((axis, i) => {
    const ctl = folder.add(v, String(i), min, max, step).name(`${label} ${axis}`);
    if (onChange) ctl.onChange(onChange);
  });
}

/** Vacía un folder de lil-gui (controles y sub-folders) para volver a llenarlo. */
function clearFolder(folder: Folder): void {
  for (const ctl of [...folder.controllers]) ctl.destroy();
  for (const sub of [...folder.folders]) sub.destroy();
}

/**
 * F2 → entidad → Particle System: todos los módulos del emisor editables en vivo. Los
 * valores se suben a la GPU cada frame; los cambios de estructura (capacidad, material,
 * renderer, módulos compilados como curl noise o luces) reconstruyen el emisor.
 * "Copy JSON" copia la configuración (formato por módulos) para pegarla en el .prefab.
 */
export function buildParticleEditor(root: Folder, ps: ParticleSystemComponent): void {
  const c = ps.getConfig();
  const rebuild = (): void => ps.rebuild();
  const curves = (): void => ps.markCurvesDirty();

  // ── Emitter ──
  const em = root.addFolder('Emitter');
  em.add(c.emitter, 'rate', 0, 5000, 1).name('Rate (/s)');
  em.add({ emitting: ps.isEmitting() }, 'emitting')
    .name('Emitting')
    .onChange((v: boolean) => (v ? ps.startEmitting() : ps.stopEmitting()));
  em.add(c.emitter, 'oneShot').name('One shot').onChange(() => ps.restart());
  em.add(c.emitter, 'burstCount', 1, 8192, 1).name('Burst count');
  em.add({ burst: () => ps.burst(c.emitter.burstCount) }, 'burst').name('▶ Burst');
  em.add(c, 'maxParticles', 1, 65536, 1).name('Max particles').onFinishChange(rebuild);
  em.add(c, 'worldSpace').name('World space').onChange(() => ps.restart());
  const materials = PARTICLE_MATERIALS.includes(c.material) ? PARTICLE_MATERIALS : [c.material, ...PARTICLE_MATERIALS];
  em.add(c, 'material', materials).name('Material').onChange(rebuild);
  em.add({ restart: () => ps.restart() }, 'restart').name('⟲ Restart');
  em.add({ copy: () => copyJson(ps) }, 'copy').name('Copy JSON');

  // ── Spawn ──
  const sp = root.addFolder('Spawn shape');
  sp.close();
  sp.add(c.spawn, 'shape', SPAWN_SHAPES).name('Shape');
  addVec3(sp, c.spawn.size, 'Size', 0, 40, 0.01);
  sp.add(c.spawn, 'radius', 0, 20, 0.01).name('Radius');
  sp.add(c.spawn, 'innerRadius', 0, 1, 0.01).name('Inner radius (0-1)');
  sp.add(c.spawn, 'angle', 0, 90, 0.5).name('Cone angle (°)');
  sp.add(c.spawn, 'radialSpeed', -30, 30, 0.05).name('Radial speed');

  // ── Init ──
  const ini = root.addFolder('Initialize');
  ini.close();
  ini.add(c.init, 'life', 0.01, 20, 0.01).name('Life (s)');
  ini.add(c.init.lifeVariance, '0', -10, 10, 0.01).name('Life var min');
  ini.add(c.init.lifeVariance, '1', -10, 10, 0.01).name('Life var max');
  addVec3(ini, c.init.velocity, 'Velocity', -30, 30, 0.05);
  ini.add(c.init, 'velocitySpread', 0, 10, 0.01).name('Velocity spread');
  ini.add(c.init, 'speedVariance', 0, 1, 0.01).name('Speed variance');
  ini.add(c.init, 'sizeVariance', 0, 1, 0.01).name('Size variance');

  // ── Forces ──
  const fo = root.addFolder('Forces');
  fo.close();
  addVec3(fo, c.forces.gravity, 'Gravity', -30, 30, 0.05);
  fo.add(c.forces, 'drag', 0, 20, 0.01).name('Drag');
  const curl = fo.addFolder('Curl noise');
  curl.close();
  curl.add(c.forces.curlNoise, 'enabled').name('Enabled').onChange(rebuild);
  curl.add(c.forces.curlNoise, 'strength', 0, 50, 0.05).name('Strength');
  curl.add(c.forces.curlNoise, 'frequency', 0.01, 5, 0.01).name('Frequency (1/m)');
  curl.add(c.forces.curlNoise, 'speed', 0, 5, 0.01).name('Flow speed');
  const vortex = fo.addFolder('Vortex');
  vortex.close();
  vortex.add(c.forces.vortex, 'enabled').name('Enabled').onChange(rebuild);
  vortex.add(c.forces.vortex, 'strength', -30, 30, 0.05).name('Spin (rad/s)');
  vortex.add(c.forces.vortex, 'pull', -50, 50, 0.05).name('Pull to axis');
  addVec3(vortex, c.forces.vortex.axis, 'Axis', -1, 1, 0.01);
  const attractor = fo.addFolder('Attractor');
  attractor.close();
  attractor.add(c.forces.attractor, 'enabled').name('Enabled').onChange(rebuild);
  attractor.add(c.forces.attractor, 'strength', -100, 100, 0.1).name('Strength');
  addVec3(attractor, c.forces.attractor.position, 'Position', -20, 20, 0.01);
  attractor.add(c.forces.attractor, 'radius', 0, 50, 0.05).name('Radius (0 = ∞)');

  // ── Over life (curvas) ──
  const ol = root.addFolder('Over life');
  ol.close();
  ol.add(c.overLife, 'brightness', 0, 50, 0.01).name('Brightness (HDR)');
  const colorKeys = ol.addFolder('Color keys');
  const fillColorKeys = (): void => {
    clearFolder(colorKeys);
    c.overLife.color.forEach((key, i) => {
      while (key.color.length < 4) key.color.push(1);
      const kf = colorKeys.addFolder(`Key ${i}`);
      kf.add(key, 't', 0, 1, 0.01).name('t').onChange(curves);
      const proxy = { rgb: key.color.slice(0, 3).map((v) => Math.min(1, Math.max(0, v))) };
      kf.addColor(proxy, 'rgb')
        .name('Color')
        .onChange((v: number[]) => {
          key.color[0] = v[0]!;
          key.color[1] = v[1]!;
          key.color[2] = v[2]!;
          curves();
        });
      kf.add(key.color, '3', 0, 1, 0.01).name('Alpha').onChange(curves);
    });
    colorKeys
      .add(
        {
          add: () => {
            const last = c.overLife.color[c.overLife.color.length - 1];
            c.overLife.color.push({ t: 1, color: last ? [...last.color] : [1, 1, 1, 1] });
            fillColorKeys();
            curves();
          },
        },
        'add',
      )
      .name('+ Key');
    colorKeys
      .add(
        {
          remove: () => {
            if (c.overLife.color.length <= 1) return;
            c.overLife.color.pop();
            fillColorKeys();
            curves();
          },
        },
        'remove',
      )
      .name('− Key');
  };
  fillColorKeys();

  const sizeKeys = ol.addFolder('Size keys');
  sizeKeys.close();
  const fillSizeKeys = (): void => {
    clearFolder(sizeKeys);
    c.overLife.size.forEach((key, i) => {
      sizeKeys.add(key, 't', 0, 1, 0.01).name(`Key ${i} t`).onChange(curves);
      sizeKeys.add(key, 'value', 0, 10, 0.005).name(`Key ${i} size`).onChange(curves);
    });
    sizeKeys
      .add(
        {
          add: () => {
            const last = c.overLife.size[c.overLife.size.length - 1];
            c.overLife.size.push({ t: 1, value: last?.value ?? 0.1 });
            fillSizeKeys();
            curves();
          },
        },
        'add',
      )
      .name('+ Key');
    sizeKeys
      .add(
        {
          remove: () => {
            if (c.overLife.size.length <= 1) return;
            c.overLife.size.pop();
            fillSizeKeys();
            curves();
          },
        },
        'remove',
      )
      .name('− Key');
  };
  fillSizeKeys();

  // ── Render ──
  const re = root.addFolder('Render');
  re.close();
  re.add(c.render, 'renderer', RENDERERS).name('Renderer').onChange(rebuild);
  re.add(c.render, 'facing', FACINGS).name('Facing');
  addVec3(re, c.render.axis, 'Facing axis', -1, 1, 0.01);
  re.add(c.render, 'stretch', 0, 0.5, 0.001).name('Velocity stretch (s)');
  re.add(c.render, 'spinSpeed', 0, 20, 0.05).name('Spin (rad/s)');
  re.add(c.render, 'tumbleSpeed', 0, 20, 0.05).name('Tumble (rad/s)');
  re.add(c.render, 'flutter', 0, 2, 0.01).name('Flutter (m)');
  re.add(c.render, 'nearFade', 0, 20, 0.05).name('Near fade (m)');
  re.add(c.render, 'softDistance', 0, 3, 0.01).name('Soft distance (m)');
  re.add(c.render, 'translucency', 0, 2, 0.01).name('Translucency (LIT)');
  re.add(c.render, 'shape', ['drop', 'mist']).name('Blood shape');
  const fb = re.addFolder('Flipbook');
  fb.close();
  fb.add(c.render.flipbook.grid, '0', 1, 16, 1).name('Columns');
  fb.add(c.render.flipbook.grid, '1', 1, 16, 1).name('Rows');
  fb.add(c.render.flipbook, 'mode', FLIPBOOK_MODES).name('Mode');
  fb.add(c.render.flipbook, 'fps', 0, 60, 0.5).name('FPS (loop)');
  fb.add(c.render.flipbook, 'blend').name('Blend frames');
  const rib = re.addFolder('Ribbon');
  rib.close();
  rib.add(c.render.ribbon, 'segments', 2, 32, 1)
    .name('Segments')
    .onFinishChange(() => {
      c.render.ribbon.segments = clampSegments(c.render.ribbon.segments);
      if (c.render.renderer === 'ribbon') rebuild();
    });
  rib.add(c.render.ribbon, 'interval', 0.005, 0.25, 0.001).name('Interval (s)');
  rib.add(c.render.ribbon, 'widthTail', 0, 2, 0.01).name('Width at tail');
  rib.add(c.render.ribbon, 'alphaTail', 0, 1, 0.01).name('Alpha at tail');

  // ── Lights ──
  const li = root.addFolder('Lights');
  li.close();
  li.add(c.lights, 'enabled').name('Enabled').onChange(rebuild);
  li.add(c.lights, 'fraction', 0, 1, 0.005).name('Fraction (biggest)');
  li.add(c.lights, 'max', 0, 256, 1).name('Max lights');
  li.add(c.lights, 'radius', 0.05, 20, 0.05).name('Radius (m)');
  li.add(c.lights, 'intensity', 0, 50, 0.05).name('Intensity');
  li.addColor(c.lights, 'color').name('Color');
  li.add(c.lights, 'useParticleColor').name('× particle color');
}

function copyJson(ps: ParticleSystemComponent): void {
  const json = JSON.stringify(particleConfigToData(ps.getConfig()), null, 2);
  console.warn(`[particle_system] ${ps.getOwner().getName()}:\n${json}`);
  navigator.clipboard?.writeText(json).catch(() => {});
}
