import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OUT, SCENARIOS, rel } from './paths.ts';
import { InputActionSchema, performInput, waitSimFrames } from './input.ts';
import type { BrowserSession } from './browser.ts';
import type { LogBuffer } from './logs.ts';

/**
 * Escenarios de test: public/data/scenarios/<nombre>.json
 *
 * El juego carga el escenario con `?scenario=<nombre>` (ModuleBoot: `scenes` sustituye a
 * boot.json y `entities` se añaden a la escena). El runner fija delta y semilla, pausa el
 * juego y ejecuta los `steps` frame a frame, de forma reproducible.
 */

const Op = z.enum([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'approx',
  'includes',
  'exists',
  'not_exists',
  'truthy',
  'falsy',
]);

export const AssertionSchema = z
  .object({
    entity: z.string().optional().describe('Entity name or id; use with `path`'),
    path: z
      .string()
      .optional()
      .describe(
        '"component.field.sub" on the entity (getters without args allowed), or "position"; with `combat`/`status`: path inside that object',
      ),
    combat: z.boolean().optional().describe('Read from __engine.getCombatState() at `path`'),
    status: z.boolean().optional().describe('Read from __engine.getStatus() at `path`'),
    expr: z
      .string()
      .optional()
      .describe('JS expression evaluated in the page (window.__engine available)'),
    no_errors: z
      .boolean()
      .optional()
      .describe('No console errors / uncaught exceptions since the scenario loaded'),
    op: Op.optional(),
    value: z.unknown().optional(),
    tolerance: z
      .number()
      .optional()
      .describe('For op "approx" (default 0.01); compares numbers or arrays element-wise'),
    message: z.string().optional(),
  })
  .strict();

const StepSchema = z.union([
  z.object({ wait_frames: z.number().int().positive() }).strict(),
  z
    .object({
      wait_seconds: z.number().positive().describe('Simulated seconds (converted with fixedDelta)'),
    })
    .strict(),
  z
    .object({
      command: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      expect_error: z.boolean().optional(),
    })
    .strict(),
  z.object({ input: z.union([InputActionSchema, z.array(InputActionSchema)]) }).strict(),
  z.object({ debug_draw: z.record(z.string(), z.boolean()) }).strict(),
  z
    .object({
      screenshot: z.string().describe('Label; saved to .mcp-out/scenarios/<name>/<label>.png'),
    })
    .strict(),
  z.object({ assert: AssertionSchema }).strict(),
  z
    .object({
      wait_until: AssertionSchema,
      timeout_frames: z.number().int().positive().optional(),
      check_every: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ eval: z.string() }).strict(),
  z.object({ log: z.string() }).strict(),
]);

export const ScenarioSchema = z
  .object({
    description: z.string().optional(),
    scenes: z.array(z.string()).optional().describe('Replaces boot.json scenes_to_load'),
    entities: z.array(z.unknown()).optional().describe('Extra entities (same format as a scene)'),
    environment: z
      .string()
      .optional()
      .describe('File in public/data/ that replaces environment.json (skybox, ambient...)'),
    seed: z.number().int().optional(),
    fixedDelta: z.number().positive().optional(),
    loadTimeoutSeconds: z.number().positive().optional(),
    failOnErrors: z
      .boolean()
      .optional()
      .describe('Default true: console errors/uncaught exceptions fail the run'),
    steps: z.array(StepSchema),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;
type Step = z.infer<typeof StepSchema>;
type Assertion = z.infer<typeof AssertionSchema>;

export function validateScenarioShape(json: unknown): { path: string; message: string }[] {
  const r = ScenarioSchema.safeParse(json);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export function listScenarios(): { name: string; description: string; steps: number }[] {
  if (!fs.existsSync(SCENARIOS)) return [];
  return fs
    .readdirSync(SCENARIOS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      try {
        const json = JSON.parse(fs.readFileSync(path.join(SCENARIOS, f), 'utf-8'));
        return { name, description: json.description ?? '', steps: json.steps?.length ?? 0 };
      } catch {
        return { name, description: '(invalid JSON)', steps: 0 };
      }
    });
}

export function loadScenario(name: string): Scenario {
  const file = path.join(SCENARIOS, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Scenario not found: ${rel(file)}. Available: ${
        listScenarios()
          .map((s) => s.name)
          .join(', ') || '(none)'
      }`,
    );
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const r = ScenarioSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      `Invalid scenario ${rel(file)}:\n${r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return r.data;
}

export interface StepResult {
  index: number;
  step: string;
  ok: boolean;
  detail: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  loadMs: number;
  steps: StepResult[];
  errors: string[];
  warnings: string[];
  screenshots: string[];
}

export async function runScenario(
  name: string,
  session: BrowserSession,
  logs: LogBuffer,
  opts: { headless?: boolean | undefined; continueOnFailure?: boolean | undefined },
): Promise<ScenarioResult> {
  const scenario = loadScenario(name);
  const fixedDelta = scenario.fixedDelta ?? 1 / 60;
  const seed = scenario.seed ?? 1;
  const result: ScenarioResult = {
    name,
    passed: false,
    loadMs: 0,
    steps: [],
    errors: [],
    warnings: [],
    screenshots: [],
  };

  if (session.isOpen() && opts.headless === undefined) {
    await session.reload({ clear: true, scenario: name, seed });
  } else {
    await session.launch({ scenario: name, seed, headless: opts.headless });
  }
  const loadStartSeq = logs.lastSeq;
  const ready = await session.waitReady((scenario.loadTimeoutSeconds ?? 120) * 1000);
  result.loadMs = ready.elapsedMs;
  if (!ready.ready) {
    result.errors.push(`Load failed: ${ready.failure}`);
    collectLogErrors(logs, loadStartSeq, result);
    return result;
  }

  await session.call('setFixedDelta', fixedDelta);
  await session.call('pause');

  const shotDir = path.join(OUT, 'scenarios', name);
  let failed = false;
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    let res: StepResult;
    try {
      res = {
        index: i,
        step: describeStep(step),
        ...(await runStep(step, session, logs, loadStartSeq, fixedDelta, shotDir, result)),
      };
    } catch (e) {
      res = { index: i, step: describeStep(step), ok: false, detail: (e as Error).message };
    }
    result.steps.push(res);
    if (!res.ok) {
      failed = true;
      if (!opts.continueOnFailure) break;
    }
  }

  collectLogErrors(logs, loadStartSeq, result);
  const errorsFail = (scenario.failOnErrors ?? true) && result.errors.length > 0;
  result.passed = !failed && !errorsFail;
  return result;
}

function collectLogErrors(logs: LogBuffer, sinceSeq: number, result: ScenarioResult): void {
  for (const e of logs.errorsSince(sinceSeq)) {
    const line = `#${e.seq} [${e.level}] ${e.text.split('\n')[0]}`;
    if (e.level === 'network') result.warnings.push(line);
    else if (!result.errors.includes(line)) result.errors.push(line);
  }
}

async function runStep(
  step: Step,
  session: BrowserSession,
  logs: LogBuffer,
  loadStartSeq: number,
  fixedDelta: number,
  shotDir: string,
  result: ScenarioResult,
): Promise<{ ok: boolean; detail: string }> {
  if ('wait_frames' in step) {
    await session.call('step', step.wait_frames);
    return { ok: true, detail: '' };
  }
  if ('wait_seconds' in step) {
    const frames = Math.ceil(step.wait_seconds / fixedDelta);
    await session.call('step', frames);
    return { ok: true, detail: `${frames} frames` };
  }
  if ('command' in step) {
    try {
      const out = await session.call('gameCommand', step.command, step.args ?? {});
      if (step.expect_error) return { ok: false, detail: `expected an error, got ${short(out)}` };
      return { ok: true, detail: short(out) };
    } catch (e) {
      if (step.expect_error)
        return { ok: true, detail: `failed as expected: ${(e as Error).message}` };
      throw e;
    }
  }
  if ('input' in step) {
    const actions = Array.isArray(step.input) ? step.input : [step.input];
    const done: string[] = [];
    for (const a of actions) done.push(await performInput(session, a));
    return { ok: true, detail: done.join('; ') };
  }
  if ('debug_draw' in step) {
    await session.call('setDebugDraw', step.debug_draw);
    return { ok: true, detail: '' };
  }
  if ('screenshot' in step) {
    // Un frame para que se pinten overlays/estado tras la pausa.
    await waitSimFrames(session, 1);
    fs.mkdirSync(shotDir, { recursive: true });
    const file = path.join(shotDir, `${step.screenshot.replace(/[^\w.-]+/g, '_')}.png`);
    await session.getPage().locator('#gfx-canvas').screenshot({ path: file });
    result.screenshots.push(rel(file));
    return { ok: true, detail: rel(file) };
  }
  if ('assert' in step) {
    return evaluateAssertion(step.assert, session, logs, loadStartSeq);
  }
  if ('wait_until' in step) {
    const timeout = step.timeout_frames ?? 600;
    const every = step.check_every ?? 5;
    let waited = 0;
    let last = await evaluateAssertion(step.wait_until, session, logs, loadStartSeq);
    while (!last.ok && waited < timeout) {
      await session.call('step', every);
      waited += every;
      last = await evaluateAssertion(step.wait_until, session, logs, loadStartSeq);
    }
    return {
      ok: last.ok,
      detail: `${last.ok ? 'after' : 'timed out after'} ${waited} frames: ${last.detail}`,
    };
  }
  if ('eval' in step) {
    const out = await evalInPage(session, step.eval);
    return { ok: true, detail: short(out) };
  }
  if ('log' in step) {
    return { ok: true, detail: step.log };
  }
  return { ok: false, detail: 'Unknown step' };
}

export async function evalInPage(session: BrowserSession, code: string): Promise<unknown> {
  return session.getPage().evaluate(async (src) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // Primero como expresión (incluye IIFEs con `return` dentro); si no compila, como sentencias.
    let fn: () => Promise<unknown>;
    try {
      fn = new AsyncFunction(`return (${src.trim().replace(/;+$/, '')});`);
    } catch {
      fn = new AsyncFunction(src);
    }
    const value = await fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (window as any).__engine;
    return engine?.serialize ? engine.serialize(value) : JSON.parse(JSON.stringify(value ?? null));
  }, code);
}

async function evaluateAssertion(
  a: Assertion,
  session: BrowserSession,
  logs: LogBuffer,
  loadStartSeq: number,
): Promise<{ ok: boolean; detail: string }> {
  if (a.no_errors) {
    const errs = logs.errorsSince(loadStartSeq).filter((e) => e.level !== 'network');
    return {
      ok: errs.length === 0,
      detail: errs.length ? errs.map((e) => e.text.split('\n')[0]).join(' | ') : 'no errors',
    };
  }

  let actual: unknown;
  let what: string;
  if (a.entity !== undefined) {
    if (!a.path) throw new Error('assert with `entity` needs `path`');
    what = `${a.entity}.${a.path}`;
    try {
      actual = await session.call('readPath', a.entity, a.path);
    } catch (e) {
      if (a.op === 'not_exists') return { ok: true, detail: `${what} does not exist` };
      throw e;
    }
  } else if (a.combat) {
    what = `combat${a.path ? `.${a.path}` : ''}`;
    actual = pick(await session.call('getCombatState'), a.path);
  } else if (a.status) {
    what = `status${a.path ? `.${a.path}` : ''}`;
    actual = pick(await session.call('getStatus'), a.path);
  } else if (a.expr) {
    what = a.expr;
    actual = await evalInPage(session, a.expr);
  } else {
    throw new Error('Assertion needs one of: entity+path, combat, status, expr, no_errors');
  }

  const op = a.op ?? (a.value === undefined ? 'truthy' : '==');
  const ok = compare(actual, op, a.value, a.tolerance ?? 0.01);
  const detail = `${what} = ${short(actual)} ${ok ? '✓' : '✗'} ${op}${a.value !== undefined ? ` ${short(a.value)}` : ''}${a.message ? ` (${a.message})` : ''}`;
  return { ok, detail };
}

function pick(obj: unknown, p: string | undefined): unknown {
  if (!p) return obj;
  let v: unknown = obj;
  for (const key of p.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

function compare(actual: unknown, op: z.infer<typeof Op>, expected: unknown, tol: number): boolean {
  switch (op) {
    case '==':
      return JSON.stringify(actual) === JSON.stringify(expected);
    case '!=':
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case '<':
      return Number(actual) < Number(expected);
    case '<=':
      return Number(actual) <= Number(expected);
    case '>':
      return Number(actual) > Number(expected);
    case '>=':
      return Number(actual) >= Number(expected);
    case 'approx':
      if (Array.isArray(actual) && Array.isArray(expected)) {
        return (
          actual.length === expected.length &&
          actual.every((v, i) => Math.abs(Number(v) - Number(expected[i])) <= tol)
        );
      }
      return Math.abs(Number(actual) - Number(expected)) <= tol;
    case 'includes':
      if (Array.isArray(actual))
        return actual.some((v) => JSON.stringify(v) === JSON.stringify(expected));
      return typeof actual === 'string' && actual.includes(String(expected));
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
  }
}

function describeStep(step: Step): string {
  const s = JSON.stringify(step);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

export function formatScenarioResult(r: ScenarioResult): string {
  const lines = [`Scenario '${r.name}': ${r.passed ? 'PASSED' : 'FAILED'}  (load ${r.loadMs}ms)`];
  for (const s of r.steps)
    lines.push(
      `  ${s.ok ? '✓' : '✗'} [${s.index}] ${s.step}${s.detail ? `\n      → ${s.detail}` : ''}`,
    );
  if (r.errors.length) lines.push('Errors:', ...r.errors.map((e) => `  ${e}`));
  if (r.warnings.length) lines.push('Warnings:', ...r.warnings.slice(0, 20).map((e) => `  ${e}`));
  if (r.screenshots.length) lines.push('Screenshots:', ...r.screenshots.map((s) => `  ${s}`));
  lines.push('(Game left paused at the end of the scenario — use `resume` or `reload`.)');
  return lines.join('\n');
}
