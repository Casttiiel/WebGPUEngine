import { defineConfig, Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import fs from 'fs';
import path from 'path';

/**
 * Vite plugin that inlines all #include directives in WGSL shader files.
 *
 * Dev:  intercepts HTTP requests for *.wgsl files and returns pre-processed content
 *       → the browser makes ONE request per shader instead of N sequential round-trips.
 * Prod: rewrites every WGSL file in dist/ so the deployed bundle needs no runtime
 *       include resolution either.
 */
function wgslIncludePlugin(): Plugin {
  const shadersRoot = path.resolve(__dirname, 'public/assets/shaders');

  function readAndInline(filePath: string, included: Set<string> = new Set()): string {
    if (included.has(filePath)) return ''; // already emitted, deduplicate
    included.add(filePath);

    const content = fs.readFileSync(filePath, 'utf-8');
    return content.replace(/#include\s*["']([^"']+)["']/g, (_match, includePath: string) => {
      const fullPath = includePath.endsWith('.wgsl') ? includePath : `${includePath}.wgsl`;
      const absPath = path.join(shadersRoot, fullPath);
      if (!fs.existsSync(absPath)) {
        console.warn(`[wgsl-include] File not found: ${absPath}`);
        return '';
      }
      // Pass shared `included` set so the same file is never emitted twice
      return readAndInline(absPath, included);
    });
  }

  return {
    name: 'wgsl-include',

    // Dev: serve pre-processed shaders from the dev server
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        // Handle all shader file extensions used by this engine
        if (!/\.(wgsl|fs|vs)$/.test(url)) return next();

        let relative = url;
        if (relative.startsWith('/WebGPUEngine/'))
          relative = relative.slice('/WebGPUEngine/'.length);
        if (relative.startsWith('/')) relative = relative.slice(1);

        const absPath = path.join(server.config.root, 'public', relative);
        if (!fs.existsSync(absPath)) return next();

        try {
          const processed = readAndInline(absPath);
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(processed);
        } catch (e) {
          console.error('[wgsl-include] Error processing', absPath, e);
          next();
        }
      });
    },

    // Prod: rewrite every WGSL file in dist/assets/shaders after build
    closeBundle() {
      const distShaders = path.resolve(__dirname, 'dist/assets/shaders');
      if (!fs.existsSync(distShaders)) return;

      const processDir = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            processDir(full);
            continue;
          }
          if (!/\.(wgsl|fs|vs)$/.test(entry.name)) continue;
          const processed = readAndInline(full);
          fs.writeFileSync(full, processed, 'utf-8');
        }
      };
      processDir(distShaders);
      console.log('[wgsl-include] All WGSL files inlined for production.');
    },
  };
}

// Plugin para devolver 404 real en lugar de index.html para assets faltantes
function no404FallbackPlugin(): Plugin {
  return {
    name: 'no-404-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';

        // Solo interceptar peticiones de assets
        if (url.startsWith('/WebGPUEngine/assets/') || url.startsWith('/assets/')) {
          // Construir ruta del archivo
          const cleanUrl = url.split('?')[0]; // Quitar query params

          // Remover el base path y obtener la ruta relativa desde public/
          let relativePath = cleanUrl;
          if (relativePath.startsWith('/WebGPUEngine/')) {
            relativePath = relativePath.substring('/WebGPUEngine/'.length);
          }
          if (relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
          }

          // La ruta completa es public/assets/...
          const filePath = path.join(server.config.root, 'public', relativePath);

          // Verificar si el archivo existe
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`404 - File not found: ${relativePath}`);
            return;
          }
        }

        next();
      });
    },
  };
}

export default defineConfig({
  base: '/WebGPUEngine/', // Ajusta esto si cambias el nombre del repo
  plugins: [wgslIncludePlugin(), no404FallbackPlugin(), wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d', 'recast-navigation'], // Excluir Rapier de la optimización de deps
  },
  server: {
    fs: {
      strict: true, // Modo estricto para acceso a archivos
    },
  },
  appType: 'spa', // Especificar que es una SPA, pero sin fallback agresivo
});
