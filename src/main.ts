import { Engine } from './core/engine/Engine';
import { Time } from './core/engine/Time';

// Esperar a que el motor cargue
try {
  (async () => {
    await Engine.start();

    let then = 0;

    // Iniciar el bucle de renderizado
    function frame(now: number) {
      now *= 0.001;
      const deltaTime = now - then;
      then = now;

      // Solo ejecutar update/render si el engine no está reiniciando
      if (!Engine.isEngineRestarting() && !Engine.isLoadingResources()) {
        Engine.update(deltaTime);
        Engine.render();
        Time.updateFPSDisplay(deltaTime);
      } else {
        const fpsDisplay = document.getElementById('fps-display');
        if (fpsDisplay) {
          fpsDisplay.innerText = `Resources Loading: ${Engine.getLoadingResourcesCount()}`;
        }
      }

      // Ocultar el loader cuando el motor esté completamente listo y no hay recursos cargando
      if (Engine.isReady() && !Engine.isLoadingResources()) {
        const loader = document.getElementById('loader');
        if (loader && !loader.classList.contains('hidden')) {
          loader.classList.add('hidden');
        }
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  })();
} catch (error) {
  console.error('Error starting engine:', error);
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('hidden');
  }
}
