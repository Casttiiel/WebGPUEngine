/**
 * Llama herramientas del MCP desde la terminal (útil para probar el servidor sin Claude).
 *
 *   npm run mcp:call -- '[["launch",{}],["screenshot",{}],["close",{}]]'
 *
 * Las imágenes se guardan en .mcp-out/call/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OUT, ROOT, rel } from './lib/paths.ts';

const calls = JSON.parse(process.argv[2] ?? '[]') as [string, Record<string, unknown>][];
const client = new Client({ name: 'mcp-call', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'tools', 'mcp', 'server.ts'),
    ],
    cwd: ROOT,
    stderr: 'inherit',
  }),
);

if (!calls.length) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name}: ${t.description}`);
}

for (const [name, args] of calls) {
  const start = Date.now();
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600000,
  })) as {
    content: { type: string; text?: string; data?: string }[];
    isError?: boolean;
  };
  console.log(
    `\n=== ${name} ${JSON.stringify(args)} (${Date.now() - start}ms)${result.isError ? ' [ERROR]' : ''}`,
  );
  for (const c of result.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image' && c.data) {
      const file = path.join(OUT, 'call', `${name}-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`[image] ${rel(file)}`);
    }
  }
}

await client.close();
process.exit(0);
