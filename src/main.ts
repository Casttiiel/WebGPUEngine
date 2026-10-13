import { Engine } from './core/engine/Engine';
import { Time } from './core/engine/Time';
import { LoadingStatus } from './core/engine/LoadingStatus';
import { RenderManagerV2 } from './renderer/core/managers/RenderManagerV2';

// Expose globals for browser console debugging
(window as any).Engine = Engine;
(window as any).RenderManager = RenderManagerV2;
import { ProfilerOverlay } from './core/debug/ProfilerOverlay';
import { Profiler } from './core/debug/Profiler';
import { DevBridge } from './core/debug/DevBridge';
import { PerfRecorder } from './core/debug/PerfRecorder';
import { Render } from './renderer/core/pipeline/Render';

// API de depuración para el MCP (window.__engine). No-op fuera de `npm run dev`.
DevBridge.install();

// Esperar a que el motor cargue
try {
  (async () => {
    try {
      // Inicializar el sistema de estado de carga
      LoadingStatus.initialize();

      await Engine.start();

      ProfilerOverlay.initialize();

      let then = 0;
      const MAX_DELTA_TIME = 0.1; // Limitar a 100ms (10 FPS mínimo)

      // Iniciar el bucle de renderizado
      function frame(nowMs: number) {
        // Frame latency limiter: while the GPU is still busy with earlier frames, skip this
        // callback instead of queueing more work (bounds input-to-screen latency).
        if (Engine.isReady() && !Render.getInstance().canStartFrame()) {
          PerfRecorder.skippedFrame();
          requestAnimationFrame(frame);
          return;
        }
        const now = nowMs * 0.001;
        const deltaTime = Math.min(now - then, MAX_DELTA_TIME);
        then = now;

        // Aplicar timeScale (para pausas, slow-motion, etc.)
        const scaledDeltaTime = deltaTime * Time.getTimeScale();

        // Solo ejecutar update/render si el engine no está reiniciando
        let updateMs = 0;
        let renderMs = 0;
        if (!Engine.isEngineRestarting()) {
          // DevBridge puede pausar, avanzar frame a frame o fijar el delta (MCP)
          const simDeltaTime = DevBridge.filterDelta(scaledDeltaTime);
          const t0 = performance.now();
          if (simDeltaTime !== null) Engine.update(simDeltaTime);
          const t1 = performance.now();
          DevBridge.beforeRender();
          Engine.render();
          updateMs = t1 - t0;
          renderMs = performance.now() - t1;
        }
        PerfRecorder.frame(nowMs, updateMs, renderMs);
        Time.updateFPSDisplay(deltaTime);
        ProfilerOverlay.update(deltaTime, Profiler.getInstance().cpu);

        // Ocultar el loader cuando el motor esté completamente listo y no hay recursos cargando
        if (Engine.isReady()) {
          LoadingStatus.hide();
        }

        requestAnimationFrame(frame);
      }

      requestAnimationFrame(frame);
    } catch (error) {
      console.error('Error starting engine:', error);
      DevBridge.setFatalError(error);
      // LoadingStatus.showError ya fue llamado en Engine.start()
    }
  })();
} catch (error) {
  console.error('Error starting engine:', error);
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('hidden');
  }
}
