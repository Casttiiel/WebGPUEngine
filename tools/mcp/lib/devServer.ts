import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ROOT, DEV_PORT, BASE_PATH } from './paths.ts';
import type { LogBuffer } from './logs.ts';

const ANSI = /\u001b\[[0-9;]*m/g;

/** Arranca (o reutiliza) el dev server de Vite en un puerto propio del MCP. */
export class DevServer {
  private child: ChildProcess | null = null;
  private owned = false;

  constructor(private readonly logs: LogBuffer) {
    const kill = () => this.stop();
    process.once('exit', kill);
    process.once('SIGINT', () => {
      kill();
      process.exit(0);
    });
  }

  public get url(): string {
    return `http://localhost:${DEV_PORT}${BASE_PATH}`;
  }

  public async isUp(): Promise<boolean> {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async ensureRunning(): Promise<{ url: string; started: boolean }> {
    if (await this.isUp()) return { url: this.url, started: false };
    if (this.child && this.child.exitCode === null) {
      await this.waitUntilUp(30000);
      return { url: this.url, started: false };
    }

    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    this.child = spawn(process.execPath, [viteBin, '--port', String(DEV_PORT), '--strictPort'], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.owned = true;
    const pipe = (chunk: Buffer) => {
      for (const line of chunk.toString().replace(ANSI, '').split(/\r?\n/)) {
        if (line.trim()) this.logs.push('vite', line.trimEnd());
      }
    };
    this.child.stdout?.on('data', pipe);
    this.child.stderr?.on('data', pipe);
    this.child.on('exit', (code) => {
      this.logs.push('vite', `[dev server exited with code ${code}]`);
      this.child = null;
    });

    await this.waitUntilUp(30000);
    return { url: this.url, started: true };
  }

  private async waitUntilUp(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isUp()) return;
      if (this.owned && !this.child)
        throw new Error('Vite dev server exited during startup (see get_logs level=vite)');
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Vite dev server did not respond at ${this.url} within ${timeoutMs}ms`);
  }

  public stop(): void {
    if (this.child && this.owned) {
      this.child.kill();
      this.child = null;
    }
  }
}
