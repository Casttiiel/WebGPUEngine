import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SRC = path.join(ROOT, 'src');
export const PUBLIC = path.join(ROOT, 'public');
export const DATA = path.join(PUBLIC, 'data');
export const ASSETS = path.join(PUBLIC, 'assets');
export const SCENARIOS = path.join(DATA, 'scenarios');
/** Salidas del MCP (screenshots de escenarios…). Ignorado por git. */
export const OUT = path.join(ROOT, '.mcp-out');

export const DEV_PORT = Number(process.env.ENGINE_DEV_PORT ?? 5199);
export const BASE_PATH = '/WebGPUEngine/';

export function rel(p: string): string {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}
