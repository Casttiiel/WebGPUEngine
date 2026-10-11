/**
 * Ejecuta los escenarios de test (public/data/scenarios) y sale con código 1 si alguno falla.
 *
 *   npm run test:scenarios                         # todos
 *   npm run test:scenarios phase2_party            # uno
 *   npm run test:scenarios phase1_camera smoke     # varios
 *
 * Usa el servidor MCP (Vite + navegador con WebGPU). Capturas en .mcp-out/scenarios/<nombre>/.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './lib/paths.ts';

const names = process.argv.slice(2);
const client = new Client({ name: 'test-scenarios', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'tools', 'mcp', 'server.ts'),
    ],
    cwd: ROOT,
    stderr: 'ignore',
  }),
);

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 })) as ToolResult;

let failed = 0;
const start = Date.now();
for (const name of names.length ? names : ['*']) {
  const result = await call('run_scenario', { name, continueOnFailure: true });
  for (const c of result.content) if (c.type === 'text') console.log(c.text);
  if (result.isError) failed++;
}
await call('close', {});
await client.close();

const seconds = ((Date.now() - start) / 1000).toFixed(0);
console.log(
  failed ? `\n✗ Scenarios FAILED (${seconds}s)` : `\n✓ All scenarios passed (${seconds}s)`,
);
process.exit(failed ? 1 : 0);
