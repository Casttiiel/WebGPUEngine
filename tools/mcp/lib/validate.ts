import fs from 'node:fs';
import path from 'node:path';
import { ASSETS, DATA, SCENARIOS, rel } from './paths.ts';
import { getComponentSchemas, type ComponentSchema, type ValueKind } from './schema.ts';
import { validateScenarioShape } from './scenario.ts';

export interface Issue {
  severity: 'error' | 'warning';
  file: string;
  path: string;
  message: string;
}

interface Ctx {
  schemas: Map<string, ComponentSchema>;
  issues: Issue[];
  file: string;
}

/** Claves que el Loader acepta además de las del switch (alias). */
const EXTRA_COMPONENT_KEYS = new Set(['player_controller']);

function listFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function readJson(file: string, issues: Issue[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    issues.push({
      severity: 'error',
      file: rel(file),
      path: '',
      message: `Invalid JSON: ${(e as Error).message}`,
    });
    return undefined;
  }
}

export function listPrefabs(): { name: string; components: string[]; children: number }[] {
  const dir = path.join(ASSETS, 'prefabs');
  return listFiles(dir, '.prefab').map((f) => {
    const name = path.relative(dir, f).replace(/\\/g, '/');
    try {
      const json = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return {
        name,
        components: Object.keys(json.components ?? {}),
        children: Array.isArray(json.children) ? json.children.length : 0,
      };
    } catch {
      return { name, components: ['(invalid JSON)'], children: 0 };
    }
  });
}

/**
 * Valida escenas, prefabs, escenarios y los JSON de configuración de `public/data` contra el
 * esquema de componentes extraído del código. `only` limita la validación a esos ficheros.
 */
export function validateData(only?: string[]): { issues: Issue[]; filesChecked: number } {
  const schemas = new Map(getComponentSchemas().map((s) => [s.key, s]));
  const issues: Issue[] = [];

  const scenes = listFiles(path.join(ASSETS, 'scenes'), '.json');
  const prefabs = listFiles(path.join(ASSETS, 'prefabs'), '.prefab');
  const scenarios = listFiles(SCENARIOS, '.json');
  const wanted = only?.map((f) => path.resolve(f).toLowerCase());
  const include = (f: string) =>
    !wanted ||
    wanted.some(
      (w) => path.resolve(f).toLowerCase() === w || rel(f).toLowerCase() === w.replace(/\\/g, '/'),
    );

  let filesChecked = 0;

  for (const file of scenes.filter(include)) {
    filesChecked++;
    const json = readJson(file, issues);
    if (json === undefined) continue;
    const ctx: Ctx = { schemas, issues, file: rel(file) };
    if (!Array.isArray(json)) {
      issues.push({
        severity: 'error',
        file: ctx.file,
        path: '',
        message: 'A scene must be a JSON array of entities',
      });
      continue;
    }
    json.forEach((e, i) => validateEntity(e, `[${i}]`, ctx));
    checkInstancedTechniques(json, ctx);
  }

  for (const file of prefabs.filter(include)) {
    filesChecked++;
    const json = readJson(file, issues);
    if (json === undefined) continue;
    validateEntity(json, '', { schemas, issues, file: rel(file) });
  }

  for (const file of scenarios.filter(include)) {
    filesChecked++;
    const json = readJson(file, issues);
    if (json === undefined) continue;
    const ctx: Ctx = { schemas, issues, file: rel(file) };
    for (const msg of validateScenarioShape(json)) {
      issues.push({ severity: 'error', file: ctx.file, path: msg.path, message: msg.message });
    }
    const scenario = json as { scenes?: unknown; entities?: unknown };
    if (Array.isArray(scenario.scenes)) {
      scenario.scenes.forEach((s, i) => checkScene(s, `scenes[${i}]`, ctx));
    }
    if (Array.isArray(scenario.entities)) {
      scenario.entities.forEach((e, i) => validateEntity(e, `entities[${i}]`, ctx));
    }
  }

  if (!only) {
    filesChecked += validateConfig(schemas, issues);
  }

  return { issues, filesChecked };
}

function checkScene(name: unknown, p: string, ctx: Ctx): void {
  if (typeof name !== 'string') {
    ctx.issues.push({
      severity: 'error',
      file: ctx.file,
      path: p,
      message: 'Scene name must be a string',
    });
    return;
  }
  if (!fs.existsSync(path.join(ASSETS, 'scenes', name))) {
    ctx.issues.push({
      severity: 'error',
      file: ctx.file,
      path: p,
      message: `Scene not found: assets/scenes/${name}`,
    });
  }
}

function validateConfig(schemas: Map<string, ComponentSchema>, issues: Issue[]): number {
  let n = 0;
  const bootFile = path.join(DATA, 'boot.json');
  if (fs.existsSync(bootFile)) {
    n++;
    const boot = readJson(bootFile, issues) as { scenes_to_load?: unknown[] } | undefined;
    const ctx: Ctx = { schemas, issues, file: rel(bootFile) };
    boot?.scenes_to_load?.forEach((s, i) => checkScene(s, `scenes_to_load[${i}]`, ctx));
  }

  const componentsFile = path.join(DATA, 'components.json');
  if (fs.existsSync(componentsFile)) {
    n++;
    const comps = readJson(componentsFile, issues) as { update?: unknown[] } | undefined;
    comps?.update?.forEach((key, i) => {
      if (typeof key === 'string' && !schemas.has(key) && !EXTRA_COMPONENT_KEYS.has(key)) {
        issues.push({
          severity: 'warning',
          file: rel(componentsFile),
          path: `update[${i}]`,
          message: `'${key}' is not a component type known by Loader.createComponentFromJSON`,
        });
      }
    });
  }

  const modulesFile = path.join(DATA, 'modules.json');
  const gamestatesFile = path.join(DATA, 'gamestates.json');
  if (fs.existsSync(modulesFile) && fs.existsSync(gamestatesFile)) {
    n += 2;
    const modules = readJson(modulesFile, issues) as { update?: string[] } | undefined;
    const gamestates = readJson(gamestatesFile, issues) as
      | { start?: string; gamestates?: Record<string, string[]> }
      | undefined;
    const known = new Set(modules?.update ?? []);
    if (gamestates?.gamestates) {
      if (gamestates.start && !(gamestates.start in gamestates.gamestates)) {
        issues.push({
          severity: 'error',
          file: rel(gamestatesFile),
          path: 'start',
          message: `Unknown start gamestate '${gamestates.start}'`,
        });
      }
      for (const [gs, mods] of Object.entries(gamestates.gamestates)) {
        mods.forEach((m, i) => {
          if (!known.has(m)) {
            issues.push({
              severity: 'warning',
              file: rel(gamestatesFile),
              path: `gamestates.${gs}[${i}]`,
              message: `Module '${m}' is not listed in modules.json update order`,
            });
          }
        });
      }
    }
  }
  return n;
}

function validateEntity(node: unknown, p: string, ctx: Ctx): void {
  const at = (sub: string) => (p ? `${p}.${sub}` : sub);
  if (!isObject(node)) {
    ctx.issues.push({
      severity: 'error',
      file: ctx.file,
      path: p,
      message: 'Entity must be an object',
    });
    return;
  }

  if (node.prefab !== undefined) {
    if (typeof node.prefab !== 'string') {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: at('prefab'),
        message: 'prefab must be a string',
      });
    } else if (!fs.existsSync(path.join(ASSETS, 'prefabs', node.prefab))) {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: at('prefab'),
        message: `Prefab not found: assets/prefabs/${node.prefab}`,
      });
    }
  }

  if (node.gltf !== undefined) {
    if (typeof node.gltf !== 'string') {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: at('gltf'),
        message: 'gltf must be a string',
      });
    } else {
      // Misma regla que GLTFLoader.loadGLTF: assets/meshes/<nombre>/<fichero>
      const folder = node.gltf.split('.')[0]!;
      if (!fs.existsSync(path.join(ASSETS, 'meshes', folder, node.gltf))) {
        ctx.issues.push({
          severity: 'error',
          file: ctx.file,
          path: at('gltf'),
          message: `GLTF not found: assets/meshes/${folder}/${node.gltf}`,
        });
      }
    }
  }

  if (node.components === undefined) {
    if (node.prefab === undefined && node.gltf === undefined) {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: p,
        message: "Entity has no 'components' (Loader requires it)",
      });
    }
  } else if (!isObject(node.components)) {
    ctx.issues.push({
      severity: 'error',
      file: ctx.file,
      path: at('components'),
      message: 'components must be an object',
    });
  } else {
    for (const [key, data] of Object.entries(node.components)) {
      validateComponent(key, data, at(`components.${key}`), ctx);
    }
  }

  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: at('children'),
        message: 'children must be an array',
      });
    } else {
      node.children.forEach((c, i) => validateEntity(c, at(`children[${i}]`), ctx));
    }
  }

  for (const key of Object.keys(node)) {
    if (!['components', 'children', 'prefab', 'gltf'].includes(key)) {
      ctx.issues.push({
        severity: 'warning',
        file: ctx.file,
        path: at(key),
        message: `Unknown entity key '${key}' (ignored by Loader)`,
      });
    }
  }
}

function validateComponent(key: string, data: unknown, p: string, ctx: Ctx): void {
  if (key === 'name') {
    if (typeof data !== 'string')
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: p,
        message: 'name must be a string',
      });
    return;
  }
  if (key === 'render') checkRenderAssets(data, p, ctx);
  const schema = ctx.schemas.get(key);
  if (!schema) {
    const suggestion = closest(key, [...ctx.schemas.keys()]);
    ctx.issues.push({
      severity: 'error',
      file: ctx.file,
      path: p,
      message: `Unknown component type '${key}' — Loader throws at runtime${suggestion ? ` (did you mean '${suggestion}'?)` : ''}`,
    });
    return;
  }
  if (!isObject(data) || schema.fields.length === 0) return;

  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  for (const [field, value] of Object.entries(data)) {
    const f = fields.get(field);
    if (!f) {
      if (!schema.open) {
        const suggestion = closest(field, [...fields.keys()]);
        ctx.issues.push({
          severity: 'warning',
          file: ctx.file,
          path: `${p}.${field}`,
          message: `'${field}' is not a field of ${schema.dataType ?? schema.className}${suggestion ? ` (did you mean '${suggestion}'?)` : ''}`,
        });
      }
      continue;
    }
    const kind = kindOfValue(value);
    if (!f.kinds.includes('any') && !f.kinds.includes(kind)) {
      ctx.issues.push({
        severity: 'warning',
        file: ctx.file,
        path: `${p}.${field}`,
        message: `Expected ${f.type}, got ${kind}`,
      });
    }
  }
}

function kindOfValue(v: unknown): ValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return t;
  return 'object';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function closest(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best && bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Un material que no existe, o cuya técnica no existe, falla al cargar (sin romper la escena). */
function checkRenderAssets(data: unknown, p: string, ctx: Ctx): void {
  if (!isObject(data) || !Array.isArray(data.meshes)) return;
  data.meshes.forEach((m, i) => {
    if (!isObject(m)) return;
    const at = `${p}.meshes[${i}]`;
    if (typeof m.mesh === 'string' && !fs.existsSync(path.join(ASSETS, 'meshes', m.mesh))) {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: `${at}.mesh`,
        message: `Mesh not found: assets/meshes/${m.mesh}`,
      });
    }
    if (typeof m.material !== 'string') return;
    const matFile = path.join(ASSETS, 'materials', m.material);
    if (!fs.existsSync(matFile)) {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: `${at}.material`,
        message: `Material not found: assets/materials/${m.material}`,
      });
      return;
    }
    try {
      const technique = JSON.parse(fs.readFileSync(matFile, 'utf-8')).technique;
      if (
        typeof technique === 'string' &&
        !fs.existsSync(path.join(ASSETS, 'techniques', technique))
      ) {
        ctx.issues.push({
          severity: 'error',
          file: ctx.file,
          path: `${at}.material`,
          message: `Material '${m.material}' uses missing technique assets/techniques/${technique}`,
        });
      }
    } catch {
      ctx.issues.push({
        severity: 'error',
        file: ctx.file,
        path: `${at}.material`,
        message: `Material '${m.material}' is not valid JSON`,
      });
    }
  });
}

/**
 * InstanceManager agrupa entidades con el mismo mesh+material y usa la técnica
 * `<tecnica>_instanced.tech`. Si esa variante no existe, el grupo falla al cargar.
 */
function checkInstancedTechniques(scene: unknown[], ctx: Ctx): void {
  const counts = new Map<string, number>();
  const walk = (node: unknown) => {
    if (!isObject(node)) return;
    const render = isObject(node.components) ? node.components.render : undefined;
    if (isObject(render) && Array.isArray(render.meshes)) {
      for (const m of render.meshes) {
        if (isObject(m) && typeof m.mesh === 'string' && typeof m.material === 'string') {
          const key = `${m.mesh}|${m.material}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  scene.forEach(walk);

  for (const [key, n] of counts) {
    if (n < 2) continue;
    const material = key.split('|')[1]!;
    const matFile = path.join(ASSETS, 'materials', material);
    if (!fs.existsSync(matFile)) continue;
    try {
      const technique: unknown = JSON.parse(fs.readFileSync(matFile, 'utf-8')).technique;
      if (typeof technique !== 'string') continue;
      const instanced = technique.replace(/\.tech$/, '_instanced.tech');
      if (!fs.existsSync(path.join(ASSETS, 'techniques', instanced))) {
        ctx.issues.push({
          severity: 'error',
          file: ctx.file,
          path: '',
          message: `${n} entities share mesh+material '${key.replace('|', ' + ')}' (instanced), but assets/techniques/${instanced} does not exist`,
        });
      }
    } catch {
      // JSON inválido: ya lo reporta checkRenderAssets
    }
  }
}
