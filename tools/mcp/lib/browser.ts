import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { LogBuffer } from './logs.ts';
import type { DevServer } from './devServer.ts';

export interface LaunchOptions {
  scene?: string | undefined;
  scenario?: string | undefined;
  seed?: number | undefined;
  headless?: boolean | undefined;
}

export interface ReadyResult {
  ready: boolean;
  elapsedMs: number;
  status?: unknown;
  failure?: string;
}

// Canvas size of the test browser. Override with ENGINE_VIEWPORT=1920x1080 (and
// ENGINE_DPR=1.5) to reproduce performance at the resolution the game is really played at.
const VIEWPORT = (() => {
  const m = /^(\d+)x(\d+)$/.exec(process.env.ENGINE_VIEWPORT ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 720 };
})();
const DEVICE_SCALE = Number(process.env.ENGINE_DPR ?? '') > 0 ? Number(process.env.ENGINE_DPR) : 1;

/**
 * Sesión de navegador controlada por Playwright. Usa un Chromium instalado en el sistema
 * (Edge por defecto en Windows; configurable con ENGINE_BROWSER_CHANNEL=chrome|msedge o
 * ENGINE_BROWSER_PATH=ruta.exe) para tener WebGPU con la GPU real.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchOpts: LaunchOptions = {};
  private lastHeadless = false;

  constructor(
    private readonly logs: LogBuffer,
    private readonly devServer: DevServer,
  ) {}

  public isOpen(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  public getPage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('The game is not running. Call `launch` first.');
    }
    return this.page;
  }

  public getLaunchOptions(): LaunchOptions {
    return { ...this.launchOpts };
  }

  public buildUrl(opts: LaunchOptions): string {
    const url = new URL(this.devServer.url);
    if (opts.scene) url.searchParams.set('scene', opts.scene);
    if (opts.scenario) url.searchParams.set('scenario', opts.scenario);
    if (opts.seed !== undefined) url.searchParams.set('seed', String(opts.seed));
    return url.toString();
  }

  public async launch(opts: LaunchOptions): Promise<{ url: string; devServerStarted: boolean }> {
    const { started } = await this.devServer.ensureRunning();
    this.launchOpts = { ...opts };

    const headless = opts.headless ?? process.env.ENGINE_HEADLESS === '1';
    if (this.browser && this.browser.isConnected() && this.lastHeadless !== headless)
      await this.close();

    if (!this.browser || !this.browser.isConnected()) {
      const executablePath = process.env.ENGINE_BROWSER_PATH;
      this.browser = await chromium.launch({
        ...(executablePath
          ? { executablePath }
          : {
              channel:
                process.env.ENGINE_BROWSER_CHANNEL ??
                (process.platform === 'win32' ? 'msedge' : 'chrome'),
            }),
        headless,
        // Sin throttling: la ventana suele quedar detrás del editor y rAF debe seguir corriendo.
        args: [
          '--enable-unsafe-webgpu',
          '--ignore-gpu-blocklist',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
      this.lastHeadless = headless;
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.context = null;
        this.page = null;
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.attachListeners(this.page);
    }

    const url = this.buildUrl(opts);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    return { url, devServerStarted: started };
  }

  /** Recarga, opcionalmente cambiando escena/escenario/semilla (undefined = mantener). */
  public async reload(opts: Partial<LaunchOptions> & { clear?: boolean }): Promise<string> {
    const page = this.getPage();
    await this.devServer.ensureRunning();
    const next: LaunchOptions = opts.clear ? {} : { ...this.launchOpts };
    if (opts.scene !== undefined) next.scene = opts.scene || undefined;
    if (opts.scenario !== undefined) next.scenario = opts.scenario || undefined;
    if (opts.seed !== undefined) next.seed = opts.seed;
    this.launchOpts = next;
    const url = this.buildUrl(next);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return url;
  }

  public async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
  }

  private attachListeners(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type();
      const level =
        type === 'error'
          ? 'error'
          : type === 'warning'
            ? 'warn'
            : type === 'info'
              ? 'info'
              : type === 'debug'
                ? 'debug'
                : 'log';
      const loc = msg.location();
      const where = loc.url ? `${shortUrl(loc.url)}:${loc.lineNumber + 1}` : undefined;
      // Los logs del Logger del motor llevan estilos CSS (%c): quitarlos para que se lean bien.
      const text = msg
        .text()
        .replace(/%c/g, '')
        .replace(/\s*font-weight:bold;.*?color:#[0-9a-f]{6}/gi, '')
        .trim();
      this.logs.push(level, text, where);
    });
    page.on('pageerror', (err) => {
      this.logs.push('pageerror', `${err.message}\n${err.stack ?? ''}`.trim());
    });
    page.on('requestfailed', (req) => {
      this.logs.push(
        'network',
        `FAILED ${req.method()} ${shortUrl(req.url())}: ${req.failure()?.errorText ?? ''}`,
      );
    });
    page.on('response', (res) => {
      if (res.status() >= 400)
        this.logs.push('network', `HTTP ${res.status()} ${shortUrl(res.url())}`);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.logs.newLoad();
        this.logs.push('info', `[mcp] navigated to ${frame.url()}`);
      }
    });
    page.on('close', () => {
      if (this.page === page) this.page = null;
    });
  }

  /**
   * Espera a que `__engine.isReady()` sea true. Falla rápido si hay un error fatal de arranque,
   * un error de compilación de Vite (overlay) o una excepción no capturada durante la carga.
   */
  public async waitReady(timeoutMs: number): Promise<ReadyResult> {
    const page = this.getPage();
    const start = Date.now();
    const startSeq = this.logs.lastSeq;
    while (Date.now() - start < timeoutMs) {
      const probe = await page
        .evaluate(() => {
          const overlay = document.querySelector('vite-error-overlay');
          if (overlay) {
            const text =
              overlay.shadowRoot?.querySelector('.window')?.textContent ??
              'Vite error overlay shown';
            return { kind: 'vite', text };
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const engine = (window as any).__engine;
          if (!engine) return { kind: 'loading' };
          const status = engine.getStatus();
          if (status.fatalError) return { kind: 'fatal', text: status.fatalError };
          if (engine.isReady()) return { kind: 'ready', status };
          return { kind: 'loading' };
        })
        .catch((e: Error) => ({ kind: 'navigating', text: e.message, status: undefined }));

      if (probe.kind === 'ready')
        return { ready: true, elapsedMs: Date.now() - start, status: probe.status };
      if (probe.kind === 'vite' || probe.kind === 'fatal') {
        return {
          ready: false,
          elapsedMs: Date.now() - start,
          failure: `${probe.kind}: ${probe.text}`,
        };
      }
      // Algunos errores no impiden arrancar: solo se aborta si tras 15s sigue sin estar listo.
      const uncaught = this.logs.errorsSince(startSeq).find((e) => e.level === 'pageerror');
      if (uncaught && Date.now() - start > 15000) {
        return {
          ready: false,
          elapsedMs: Date.now() - start,
          failure: `uncaught error during load: ${uncaught.text}`,
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ready: false, elapsedMs: Date.now() - start, failure: `timeout after ${timeoutMs}ms` };
  }

  /** Llama a un método de `window.__engine` y devuelve su resultado (await incluido). */
  public async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const page = this.getPage();
    return page.evaluate(
      async ({ method, args }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (window as any).__engine;
        if (!engine)
          throw new Error(
            'window.__engine is not available (is this a dev build? did the page load?)',
          );
        const fn = engine[method];
        if (typeof fn !== 'function') throw new Error(`__engine.${method} is not a function`);
        return await fn(...args);
      },
      { method, args },
    ) as Promise<T>;
  }

  /** Convierte coordenadas relativas al canvas en coordenadas de página. */
  public async canvasOrigin(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.getPage().locator('#gfx-canvas').boundingBox();
    if (!box) throw new Error('#gfx-canvas not found');
    return box;
  }
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/localhost:\d+/, '');
}
