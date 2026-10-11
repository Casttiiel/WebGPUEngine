import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.ts';

export interface Diagnostic {
  tool: 'tsc' | 'eslint';
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function run(
  args: string[],
  timeoutMs = 300000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function normalize(file: string): string {
  return path.relative(ROOT, path.resolve(ROOT, file)).replace(/\\/g, '/');
}

/** Type-check de un proyecto (por defecto el del juego; tools/mcp tiene su propio tsconfig). */
export async function runTsc(project = 'tsconfig.json'): Promise<Diagnostic[]> {
  const { stdout, stderr } = await run([
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    project,
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const diags: Diagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
  for (const line of (stdout + stderr).split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      diags.push({
        tool: 'tsc',
        severity: m[4] === 'warning' ? 'warning' : 'error',
        file: normalize(m[1]!),
        line: Number(m[2]),
        column: Number(m[3]),
        code: m[5]!,
        message: m[6]!,
      });
    } else if (line.startsWith('  ') && diags.length) {
      diags[diags.length - 1]!.message += `\n${line.trimEnd()}`;
    }
  }
  return diags;
}

interface EslintResult {
  filePath: string;
  messages: {
    ruleId: string | null;
    severity: number;
    message: string;
    line?: number;
    column?: number;
  }[];
}

export async function runEslint(files?: string[]): Promise<Diagnostic[]> {
  const targets = files && files.length ? files : ['src/**/*.{ts,tsx}'];
  const { stdout, stderr } = await run([
    path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    '-f',
    'json',
    '--no-warn-ignored',
    ...targets,
  ]);
  let results: EslintResult[];
  try {
    results = JSON.parse(stdout) as EslintResult[];
  } catch {
    throw new Error(`Could not parse eslint output:\n${(stderr || stdout).slice(0, 2000)}`);
  }
  const diags: Diagnostic[] = [];
  for (const r of results) {
    for (const m of r.messages) {
      diags.push({
        tool: 'eslint',
        severity: m.severity >= 2 ? 'error' : 'warning',
        file: normalize(r.filePath),
        line: m.line ?? 0,
        column: m.column ?? 0,
        code: m.ruleId ?? 'eslint',
        message: m.message,
      });
    }
  }
  return diags;
}

function git(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, windowsHide: true });
    let s = '';
    child.stdout.on('data', (d: Buffer) => (s += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(s));
  });
}

/**
 * Líneas cambiadas respecto a HEAD por fichero ('all' = fichero nuevo/no versionado).
 * Sirve para no mostrar errores que ya existían en líneas que no se han tocado.
 */
export async function changedLines(): Promise<Map<string, Set<number> | 'all'>> {
  const result = new Map<string, Set<number> | 'all'>();
  for (const f of await changedFiles()) result.set(f, 'all');
  const diff = await git(['diff', '-U0', '--no-color', 'HEAD']);
  let current: Set<number> | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file) {
      current = new Set<number>();
      result.set(file[1]!, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = start; i < start + count; i++) current.add(i);
    }
  }
  return result;
}

/** Ficheros modificados respecto a HEAD + no versionados (rutas relativas al repo). */
export async function changedFiles(): Promise<string[]> {
  const out = await git(['status', '--porcelain', '-uall']);
  return out
    .split(/\r?\n/)
    .filter((l) => l.length > 3 && !l.startsWith(' D') && !l.startsWith('D '))
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(' -> ');
      return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
    });
}

export function formatDiagnostics(diags: Diagnostic[], limit: number): string {
  const lines = diags
    .slice(0, limit)
    .map((d) => `${d.file}:${d.line}:${d.column} ${d.severity} ${d.tool}/${d.code}: ${d.message}`);
  if (diags.length > limit) lines.push(`… ${diags.length - limit} more`);
  return lines.join('\n');
}
