import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: '/WebGPUEngine/', // Ajusta esto si cambias el nombre del repo
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d'], // Excluir Rapier de la optimización de deps
  },
});
