import { defineConfig, Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import fs from 'fs';
import path from 'path';

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
  plugins: [no404FallbackPlugin(), wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d'], // Excluir Rapier de la optimización de deps
  },
  server: {
    fs: {
      strict: true, // Modo estricto para acceso a archivos
    },
  },
  appType: 'spa', // Especificar que es una SPA, pero sin fallback agresivo
});
