/**
 * MCP server del motor WebGPU — permite a Claude arrancar el juego, observarlo, controlarlo
 * y verificar resultados. El motor NO se edita en vivo: el contenido vive en ficheros
 * (código, escenas, prefabs) y el juego en ejecución solo se observa y controla.
 *
 * Arranque: registrado en .mcp.json (`node node_modules/tsx/dist/cli.mjs tools/mcp/server.ts`).
 * Variables: ENGINE_DEV_PORT (5199), ENGINE_BROWSER_CHANNEL (msedge|chrome),
 *            ENGINE_BROWSER_PATH, ENGINE_HEADLESS=1.
 */

// stdout es el canal del protocolo MCP: cualquier console.log debe ir a stderr.
console.log = console.error;
console.info = console.error;

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LogBuffer, formatLogs, type LogLevel } from './lib/logs.ts';
import { DevServer } from './lib/devServer.ts';
import { BrowserSession } from './lib/browser.ts';
import {
  runTsc,
  runEslint,
  changedLines,
  formatDiagnostics,
  type Diagnostic,
} from './lib/checks.ts';
import { getComponentSchemas, formatSchema } from './lib/schema.ts';
import { validateData, listPrefabs } from './lib/validate.ts';
import { InputActionSchema, performInput } from './lib/input.ts';
import { runScenario, listScenarios, formatScenarioResult, evalInPage } from './lib/scenario.ts';
import { ROOT, OUT, rel } from './lib/paths.ts';

const logs = new LogBuffer();
const devServer = new DevServer(logs);
const session = new BrowserSession(logs, devServer);

const server = new McpServer({ name: 'webgpu-engine', version: '0.1.0' });

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });
/** JSON indentado, pero con los arrays de primitivos en una sola línea ([x, y, z]). */
const json = (v: unknown): ToolResult =>
  text(
    (JSON.stringify(v, null, 2) ?? 'undefined').replace(
      /\[\s+([^[\]{}]*?)\s+\]/g,
      (_m, inner: string) => `[${inner.replace(/\s*\n\s*/g, ' ')}]`,
    ),
  );
const fail = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

/** Envuelve un handler: los errores se devuelven como resultado de error en vez de romper el servidor. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const err = e as Error;
      // Los errores lanzados dentro de page.evaluate llegan con prefijo y la pila del navegador.
      const message = err.message.replace(/^page\.evaluate: (Error: )?/, '').split('\n    at ')[0];
      return fail(`${message}${process.env.MCP_DEBUG ? `\n${err.stack}` : ''}`);
    }
  };
}

const pointRef = z
  .union([z.tuple([z.number(), z.number(), z.number()]), z.string(), z.number()])
  .describe('World position [x,y,z], entity name, or entity id');

/** Errores nuevos desde una marca del log, en una línea por error. */
function errorSummary(sinceSeq: number): string {
  const errs = logs.errorsSince(sinceSeq);
  if (!errs.length) return 'No errors.';
  return `${errs.length} error(s):\n${formatLogs(errs.slice(-15))}`;
}

async function readyReport(
  sinceSeq: number,
  timeoutSeconds: number,
  header: string,
  waitNavMesh = false,
): Promise<ToolResult> {
  const ready = await session.waitReady(timeoutSeconds * 1000);
  // El navmesh se construye en un worker y puede llegar después de "ready".
  let navNote = '';
  if (ready.ready && waitNavMesh) {
    const start = Date.now();
    let built = false;
    while (!built && Date.now() - start < 30000) {
      built = (await session.call<{ navMeshBuilt?: boolean }>('getStatus')).navMeshBuilt === true;
      if (!built) await new Promise((r) => setTimeout(r, 250));
    }
    navNote = built
      ? `NavMesh built (+${Date.now() - start}ms).`
      : 'NavMesh NOT built after 30s (does the scene have a navmesh/terrain?).';
  }
  const body = [
    header,
    ready.ready
      ? `Ready in ${ready.elapsedMs}ms.`
      : `NOT READY after ${ready.elapsedMs}ms: ${ready.failure}`,
    navNote,
    ready.status ? `Status: ${JSON.stringify(ready.status)}` : '',
    errorSummary(sinceSeq),
  ]
    .filter(Boolean)
    .join('\n');
  return ready.ready ? text(body) : fail(body);
}

// ═══════════════════════════════════════════════════════════════════════════
// 0.1 Ciclo de vida y observación
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'launch',
  {
    description:
      'Start the Vite dev server (if needed) and open the game in a browser (Playwright + system Edge/Chrome with WebGPU). Waits until the scene is loaded. Reuses the browser if already open.',
    inputSchema: {
      scene: z
        .string()
        .optional()
        .describe(
          'Comma-separated scene files from assets/scenes (overrides boot.json), e.g. "playground.json"',
        ),
      scenario: z
        .string()
        .optional()
        .describe('Scenario name from public/data/scenarios (without .json)'),
      seed: z.number().int().optional().describe('Seed for Math.random (reproducible rolls)'),
      headless: z
        .boolean()
        .optional()
        .describe('Run without a visible window (default false; WebGPU may not work headless)'),
      timeoutSeconds: z.number().optional().describe('Max seconds to wait for ready (default 120)'),
      waitNavMesh: z
        .boolean()
        .optional()
        .describe('Also wait until the navmesh is built (async worker), up to 30s'),
    },
  },
  safe(async (a) => {
    const mark = logs.lastSeq;
    const { url, devServerStarted } = await session.launch(a);
    return readyReport(
      mark,
      a.timeoutSeconds ?? 120,
      `Opened ${url}${devServerStarted ? ' (dev server started)' : ''}`,
      a.waitNavMesh,
    );
  }),
);

server.registerTool(
  'reload',
  {
    description:
      'Reload the game page (after editing files) and wait until ready. Vite compile errors are reported instead of hanging. Omitted options keep the current scene/scenario/seed; pass "" to clear one.',
    inputSchema: {
      scene: z.string().optional(),
      scenario: z.string().optional(),
      seed: z.number().int().optional(),
      clear: z.boolean().optional().describe('Drop all previous scene/scenario/seed options'),
      timeoutSeconds: z.number().optional(),
      waitNavMesh: z.boolean().optional(),
    },
  },
  safe(async (a) => {
    if (!session.isOpen()) return fail('The game is not running. Call `launch` first.');
    const mark = logs.lastSeq;
    const url = await session.reload(a);
    return readyReport(mark, a.timeoutSeconds ?? 120, `Reloaded ${url}`, a.waitNavMesh);
  }),
);

server.registerTool(
  'close',
  {
    description: 'Close the browser and stop the dev server started by the MCP.',
    inputSchema: { keepDevServer: z.boolean().optional() },
  },
  safe(async (a) => {
    await session.close();
    if (!a.keepDevServer) devServer.stop();
    return text('Closed.');
  }),
);

server.registerTool(
  'get_status',
  {
    description:
      'Game status: ready, FPS, gamestate, entity count, navmesh, time/pause state, seed, overlays, launch options.',
    inputSchema: {},
  },
  safe(async () => {
    const base = {
      browserOpen: session.isOpen(),
      devServerUp: await devServer.isUp(),
      launch: session.getLaunchOptions(),
    };
    if (!session.isOpen()) return json(base);
    const status = await session.call('getStatus').catch((e: Error) => ({ error: e.message }));
    return json({ ...base, ...(status as object) });
  }),
);

server.registerTool(
  'get_logs',
  {
    description:
      'Browser console (log/warn/error), uncaught exceptions (pageerror), failed/4xx network requests and Vite dev server output. By default only the current page load.',
    inputSchema: {
      levels: z
        .array(z.enum(['log', 'info', 'debug', 'warn', 'error', 'pageerror', 'network', 'vite']))
        .optional()
        .describe('Filter by level. Shortcut: use errorsOnly'),
      errorsOnly: z.boolean().optional().describe('Only error, pageerror and network'),
      allLoads: z.boolean().optional().describe('Include logs from previous page loads'),
      sinceSeq: z.number().int().optional().describe('Only entries after this sequence number'),
      contains: z.string().optional(),
      limit: z.number().int().optional().describe('Default 100 (most recent)'),
    },
  },
  safe(async (a) => {
    const levels: LogLevel[] | undefined = a.errorsOnly
      ? ['error', 'pageerror', 'network']
      : a.levels;
    const entries = logs.query({
      ...(levels ? { levels } : {}),
      ...(a.sinceSeq !== undefined ? { sinceSeq: a.sinceSeq } : {}),
      ...(a.contains ? { contains: a.contains } : {}),
      currentLoadOnly: !a.allLoads && !levels?.includes('vite'),
      limit: a.limit ?? 100,
    });
    return text(`${formatLogs(entries)}\n(last seq: ${logs.lastSeq})`);
  }),
);

server.registerTool(
  'screenshot',
  {
    description:
      'Capture the game. Returns the image. Optionally enable debug overlays first or hide the debug UI panels.',
    inputSchema: {
      fullPage: z
        .boolean()
        .optional()
        .describe('Whole viewport including HTML UI (default: only the canvas)'),
      hideDebugUi: z
        .boolean()
        .optional()
        .describe('Hide lil-gui / FPS / profiler overlays for the capture'),
      overlays: z
        .record(z.string(), z.boolean())
        .optional()
        .describe('Debug overlays to set before capturing (see debug_draw)'),
      waitFrames: z
        .number()
        .int()
        .optional()
        .describe('Simulated frames to advance/wait before capturing'),
      saveAs: z.string().optional().describe('Also save under .mcp-out/screenshots/<name>.png'),
    },
  },
  safe(async (a) => {
    const page = session.getPage();
    if (a.overlays) await session.call('setDebugDraw', a.overlays);
    if (a.waitFrames) {
      const t = await session.call<{ paused: boolean }>('getTimeState');
      await session.call(t.paused ? 'step' : 'waitFrames', a.waitFrames);
    } else {
      // Asegura al menos un frame pintado con el estado actual (también en pausa).
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    }
    if (a.hideDebugUi) {
      await page.addStyleTag({
        content:
          '.lil-gui, #fps-display, #profiler-overlay, .tp-dfwv { visibility: hidden !important; }',
      });
    }
    const buf = a.fullPage
      ? await page.screenshot()
      : await page.locator('#gfx-canvas').screenshot();
    if (a.hideDebugUi) {
      await page.evaluate(() =>
        document
          .querySelectorAll('style')
          .forEach((s) => s.textContent?.includes('.lil-gui, #fps-display') && s.remove()),
      );
    }
    const content: Content[] = [
      { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
    ];
    if (a.saveAs) {
      const file = path.join(OUT, 'screenshots', `${a.saveAs.replace(/[^\w.-]+/g, '_')}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      content.push({ type: 'text', text: `Saved ${rel(file)}` });
    }
    return { content };
  }),
);

server.registerTool(
  'run_checks',
  {
    description:
      'Run TypeScript type-check and ESLint. The repo has pre-existing errors, so by default only diagnostics in files changed vs git HEAD (+ untracked) are listed; totals are always reported.',
    inputSchema: {
      typecheck: z.boolean().optional().describe('Default true'),
      lint: z.boolean().optional().describe('Default true'),
      scope: z.enum(['changed', 'all']).optional().describe('Default "changed"'),
      files: z
        .array(z.string())
        .optional()
        .describe('Explicit repo-relative files to report on (overrides scope)'),
      includeWarnings: z.boolean().optional().describe('Default false for eslint warnings'),
      limit: z.number().int().optional().describe('Max diagnostics listed (default 60)'),
    },
  },
  safe(async (a) => {
    const scope = a.scope ?? 'changed';
    // En modo "changed" se filtra por líneas cambiadas, para no arrastrar errores previos.
    const lines = !a.files && scope === 'changed' ? await changedLines() : null;
    const filter =
      a.files?.map((f) => f.replace(/\\/g, '/')) ??
      (lines ? [...lines.keys()].filter((f) => /\.(ts|tsx)$/.test(f)) : undefined);
    const lintTargets = filter?.filter((f) => f.startsWith('src/'));

    const [tsc, tscTools, eslint] = await Promise.all([
      a.typecheck === false ? Promise.resolve([] as Diagnostic[]) : runTsc(),
      a.typecheck === false
        ? Promise.resolve([] as Diagnostic[])
        : runTsc('tools/mcp/tsconfig.json'),
      a.lint === false || (lintTargets && lintTargets.length === 0)
        ? Promise.resolve([] as Diagnostic[])
        : runEslint(lintTargets),
    ]);
    const inScope = (d: Diagnostic) => {
      if (!filter) return true;
      if (!filter.includes(d.file)) return false;
      const changed = lines?.get(d.file);
      return !changed || changed === 'all' || changed.has(d.line);
    };
    const all = [...tsc, ...tscTools, ...eslint].filter(
      (d) => a.includeWarnings || d.severity === 'error',
    );
    const shown = all.filter(inScope);
    const count = (ds: Diagnostic[], sev: string) => ds.filter((d) => d.severity === sev).length;

    const summary = [
      `tsc: ${count(tsc, 'error')} errors in the game project (pre-existing ones included), ${count(tscTools, 'error')} in tools/mcp`,
      `eslint: ${count(eslint, 'error')} errors, ${count(eslint, 'warning')} warnings${filter ? ' (in scoped files)' : ''}`,
      filter
        ? `Scope: ${lines ? 'changed lines in ' : ''}${filter.length} file(s): ${filter.slice(0, 20).join(', ')}${filter.length > 20 ? '…' : ''}`
        : 'Scope: all files',
      shown.length
        ? `\n${shown.length} diagnostic(s) in scope:\n${formatDiagnostics(shown, a.limit ?? 60)}`
        : '\nNo diagnostics in scope. ✓',
    ];
    return text(summary.join('\n'));
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 0.2 Validación de datos (sin ejecutar)
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'list_components',
  {
    description:
      'Component types accepted in scenes/prefabs (from Loader.createComponentFromJSON) with their JSON fields and types, extracted from each component load() signature via the TypeScript compiler.',
    inputSchema: {
      names: z.array(z.string()).optional().describe('Only these component keys (shows fields)'),
      search: z.string().optional().describe('Substring filter on key or class name'),
      fields: z
        .boolean()
        .optional()
        .describe('Show fields for every listed component (default: only when names given)'),
    },
  },
  safe(async (a) => {
    let schemas = getComponentSchemas();
    if (a.names?.length) schemas = schemas.filter((s) => a.names!.includes(s.key));
    if (a.search) {
      const q = a.search.toLowerCase();
      schemas = schemas.filter((s) => s.key.includes(q) || s.className.toLowerCase().includes(q));
    }
    const verbose = a.fields ?? Boolean(a.names?.length);
    return text(
      `${schemas.length} component type(s):\n${schemas.map((s) => formatSchema(s, verbose)).join('\n')}`,
    );
  }),
);

server.registerTool(
  'list_prefabs',
  {
    description:
      'Prefabs under public/assets/prefabs (name to use in "prefab": "...") with their components.',
    inputSchema: { search: z.string().optional() },
  },
  safe(async (a) => {
    const q = a.search?.toLowerCase();
    const prefabs = listPrefabs().filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.components.some((c) => c.includes(q)),
    );
    return text(
      prefabs
        .map(
          (p) =>
            `${p.name}  [${p.components.join(', ')}]${p.children ? `  +${p.children} children` : ''}`,
        )
        .join('\n'),
    );
  }),
);

server.registerTool(
  'validate_data',
  {
    description:
      'Validate scenes, prefabs, scenarios and data/*.json without running the game: unknown component types (Loader would throw), unknown/mistyped fields, missing prefabs/GLTF/scenes, invalid scenario steps, gamestate/module references.',
    inputSchema: {
      files: z
        .array(z.string())
        .optional()
        .describe('Only these files (repo-relative). Default: everything'),
      includeWarnings: z.boolean().optional().describe('Default true'),
      limit: z.number().int().optional().describe('Default 100'),
    },
  },
  safe(async (a) => {
    const { issues, filesChecked } = validateData(a.files?.map((f) => path.resolve(ROOT, f)));
    const shown = issues.filter((i) => a.includeWarnings !== false || i.severity === 'error');
    const errors = issues.filter((i) => i.severity === 'error').length;
    const lines = shown
      .slice(0, a.limit ?? 100)
      .map(
        (i) => `${i.severity.toUpperCase()} ${i.file}${i.path ? ` @ ${i.path}` : ''}: ${i.message}`,
      );
    if (shown.length > (a.limit ?? 100)) lines.push(`… ${shown.length - (a.limit ?? 100)} more`);
    return text(
      `Checked ${filesChecked} file(s): ${errors} error(s), ${issues.length - errors} warning(s).\n${lines.join('\n')}`,
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 0.3 Inspección del juego en ejecución (solo lectura)
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'list_entities',
  {
    description:
      'Entities in the running game: id, name, components, world position, parent/children count.',
    inputSchema: {
      name: z.string().optional().describe('Case-insensitive substring'),
      component: z.string().optional().describe('Only entities with this component key'),
      limit: z.number().int().optional().describe('Default 200'),
      includePool: z.boolean().optional().describe('Include pooled entities (bullets…)'),
    },
  },
  safe(async (a) => json(await session.call('listEntities', a))),
);

server.registerTool(
  'get_entity',
  {
    description:
      'Dump one entity: summary, children and the runtime fields of its components (depth-limited, GPU/physics handles elided).',
    inputSchema: {
      entity: z.union([z.string(), z.number()]).describe('Entity name or id'),
      components: z.array(z.string()).optional().describe('Only these component keys'),
    },
  },
  safe(async (a) => json(await session.call('getEntity', a.entity, a.components))),
);

server.registerTool(
  'eval',
  {
    description:
      'Evaluate JavaScript in the game page for one-off debugging questions (window.__engine and window.Engine available). An expression returns its value; multi-statement code must `return`. Do not use it to author content: content lives in files.',
    inputSchema: { code: z.string() },
  },
  safe(async (a) => json(await evalInPage(session, a.code))),
);

server.registerTool(
  'perf_capture',
  {
    description:
      'Record frame-by-frame performance for N seconds of real time (game keeps running) and report: fps, frame-interval percentiles and hitches, CPU update/render and scopes, raw GPU time per frame and per pass, submit→GPU-done latency, GC events, long tasks, pipeline compiles / bind groups / buffer uploads / texture loads, the 10 worst frames with what they did, and a plain-language diagnosis. Use it to find the cause of stutter that an average FPS hides.',
    inputSchema: {
      seconds: z.number().min(0.5).max(60).optional().describe('Capture length (default 5)'),
      warmupSeconds: z
        .number()
        .min(0)
        .max(60)
        .optional()
        .describe('Wait before recording so loading/streaming does not pollute the capture (default 0)'),
    },
  },
  safe(async (a) => {
    if (a.warmupSeconds) await new Promise((r) => setTimeout(r, a.warmupSeconds! * 1000));
    return json(await session.call('perfCapture', a.seconds ?? 5));
  }),
);

server.registerTool(
  'alloc_profile',
  {
    description:
      'Sample JS heap allocations for N seconds while the game runs (Chrome DevTools HeapProfiler sampling) and list the functions that allocate the most memory, with source location. Use it to find the per-frame allocations behind garbage-collection churn.',
    inputSchema: {
      seconds: z.number().min(1).max(60).optional().describe('Sampling length (default 5)'),
      top: z.number().int().min(5).max(100).optional().describe('Rows to return (default 25)'),
    },
  },
  safe(async (a) => {
    const seconds = a.seconds ?? 5;
    const page = session.getPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    // Small interval: per-frame allocations are many small objects
    // Include objects already garbage-collected: per-frame garbage is what we are after
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    } as never);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as {
      profile: {
        head: AllocNode;
        samples: { size: number; nodeId: number }[];
      };
    };
    await cdp.detach();

    type AllocNode = {
      id: number;
      selfSize: number;
      callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
      children: AllocNode[];
    };
    // Aggregate self size per function (url:line), plus the immediate caller of the top sites
    const bySite = new Map<string, { bytes: number; callers: Map<string, number> }>();
    const short = (cf: AllocNode['callFrame']) =>
      `${cf.functionName || '(anonymous)'} ${cf.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
    const walk = (node: AllocNode, parent: AllocNode | null) => {
      if (node.selfSize > 0) {
        const key = short(node.callFrame);
        const entry = bySite.get(key) ?? { bytes: 0, callers: new Map() };
        entry.bytes += node.selfSize;
        if (parent) {
          const pk = short(parent.callFrame);
          entry.callers.set(pk, (entry.callers.get(pk) ?? 0) + node.selfSize);
        }
        bySite.set(key, entry);
      }
      for (const child of node.children) walk(child, node);
    };
    walk(profile.head, null);

    const total = [...bySite.values()].reduce((sum, e) => sum + e.bytes, 0);
    const rows = [...bySite.entries()]
      .sort((x, y) => y[1].bytes - x[1].bytes)
      .slice(0, a.top ?? 25)
      .map(([site, e]) => {
        const caller = [...e.callers.entries()].sort((x, y) => y[1] - x[1])[0];
        return {
          site,
          MBperSec: Math.round((e.bytes / seconds / (1024 * 1024)) * 100) / 100,
          pct: Math.round((e.bytes / Math.max(total, 1)) * 1000) / 10,
          ...(caller ? { topCaller: caller[0] } : {}),
        };
      });
    return json({
      seconds,
      sampledMBperSec: Math.round((total / seconds / (1024 * 1024)) * 100) / 100,
      note: 'Sampled allocations (statistical): rates are estimates; relative ranking is what matters.',
      rows,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 0.4 Control: tiempo, input y determinismo
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'pause',
  {
    description: 'Pause the simulation (rendering continues). Use step to advance.',
    inputSchema: {},
  },
  safe(async () => json(await session.call('pause'))),
);

server.registerTool(
  'resume',
  { description: 'Resume the simulation in real time.', inputSchema: {} },
  safe(async () => json(await session.call('resume'))),
);

server.registerTool(
  'step',
  {
    description:
      'Pause (if needed) and advance exactly N simulated frames with a fixed delta (default 1/60 s).',
    inputSchema: {
      frames: z.number().int().positive().optional().describe('Default 1'),
      fixedDelta: z
        .number()
        .positive()
        .optional()
        .describe('Seconds per frame for steps and while running; persists until changed'),
    },
  },
  safe(async (a) => {
    if (a.fixedDelta) await session.call('setFixedDelta', a.fixedDelta);
    return json(await session.call('step', a.frames ?? 1));
  }),
);

server.registerTool(
  'set_time_scale',
  {
    description:
      'Game time multiplier (Time.timeScale): 2 = double speed, 0.5 = slow motion. Optionally force a fixed delta per frame (null to clear).',
    inputSchema: {
      scale: z.number().min(0).optional(),
      fixedDelta: z.number().positive().nullable().optional(),
    },
  },
  safe(async (a) => {
    if (a.fixedDelta !== undefined) await session.call('setFixedDelta', a.fixedDelta);
    if (a.scale !== undefined) await session.call('setTimeScale', a.scale);
    return json(await session.call('getTimeState'));
  }),
);

server.registerTool(
  'simulate_input',
  {
    description:
      'Send real mouse/keyboard input through the browser (same path as a player). Targets can be canvas pixels, world positions or entities (projected with the main camera). Actions run in order. Note: if the game is paused, input is consumed on the next stepped frame.',
    inputSchema: { actions: z.array(InputActionSchema).min(1) },
  },
  safe(async (a) => {
    const done: string[] = [];
    for (const action of a.actions) done.push(await performInput(session, action));
    return text(done.join('\n'));
  }),
);

// La semilla se fija al lanzar (launch/reload con seed → ?seed=N), igual que en los escenarios.

// ═══════════════════════════════════════════════════════════════════════════
// 0.5 Herramientas específicas del juego táctico
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'get_combat_state',
  {
    description:
      'Turn order, active unit, remaining actions/movement, HP and state of every combatant. Requires the combat system to register a provider (DevBridge.registerCombatProvider).',
    inputSchema: {},
  },
  safe(async () => json(await session.call('getCombatState'))),
);

server.registerTool(
  'game_command',
  {
    description:
      'Execute a high-level game action like the player would: move(unit,pos), attack(unit,target), use_skill(unit,skill,target), end_turn(). Same API the enemy AI uses. Requires a registered combat provider.',
    inputSchema: {
      command: z.string().describe('e.g. "move", "attack", "use_skill", "end_turn"'),
      args: z.record(z.string(), z.unknown()).optional(),
    },
  },
  safe(async (a) => json(await session.call('gameCommand', a.command, a.args ?? {}))),
);

server.registerTool(
  'query_path',
  {
    description:
      'Navmesh path between two points/entities: reachable, length (m), waypoints. The path is drawn for 10s when the "paths" overlay is on.',
    inputSchema: { from: pointRef, to: pointRef },
  },
  safe(async (a) => json(await session.call('queryPath', a.from, a.to))),
);

server.registerTool(
  'query_los',
  {
    description:
      'Line of sight (physics raycast) between two points/entities. For entities, eyeHeight is added to their pivot. Returns the blocking entity if any. Drawn with the "los" overlay.',
    inputSchema: {
      from: pointRef,
      to: pointRef,
      eyeHeight: z.number().optional().describe('Default 1.5 m (only applied to entity endpoints)'),
    },
  },
  safe(async (a) => json(await session.call('queryLos', a.from, a.to, a.eyeHeight ?? 1.5))),
);

server.registerTool(
  'debug_draw',
  {
    description:
      'Toggle debug overlays: colliders, sensors, lights, cameras, navmesh, paths, los, plus any overlay registered by game systems. Call with no args to list current state.',
    inputSchema: { overlays: z.record(z.string(), z.boolean()).optional() },
  },
  safe(async (a) =>
    json(
      a.overlays
        ? await session.call('setDebugDraw', a.overlays)
        : await session.call('getDebugDraw'),
    ),
  ),
);

server.registerTool(
  'list_scenarios',
  { description: 'Test scenarios in public/data/scenarios.', inputSchema: {} },
  safe(async () => {
    const list = listScenarios();
    return text(
      list.length
        ? list.map((s) => `${s.name} (${s.steps} steps) — ${s.description}`).join('\n')
        : 'No scenarios.',
    );
  }),
);

server.registerTool(
  'run_scenario',
  {
    description:
      'Load a scenario file (public/data/scenarios/<name>.json: scenes, extra entities, seed, steps with commands/input/waits/asserts), run it deterministically (paused + fixed delta) and report pass/fail per step. name="*" runs all.',
    inputSchema: {
      name: z.string(),
      headless: z.boolean().optional(),
      continueOnFailure: z.boolean().optional(),
    },
  },
  safe(async (a) => {
    const names = a.name === '*' ? listScenarios().map((s) => s.name) : [a.name];
    const reports: string[] = [];
    let allPassed = true;
    for (const n of names) {
      const r = await runScenario(n, session, logs, {
        headless: a.headless,
        continueOnFailure: a.continueOnFailure,
      });
      allPassed &&= r.passed;
      reports.push(formatScenarioResult(r));
    }
    if (names.length > 1)
      reports.unshift(`${names.length} scenarios: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
    return allPassed ? text(reports.join('\n\n')) : fail(reports.join('\n\n'));
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[webgpu-engine mcp] ready');
