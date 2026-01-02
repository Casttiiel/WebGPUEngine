import { Engine } from './core/engine/Engine';
import { Time } from './core/engine/Time';
import { LoadingStatus } from './core/engine/LoadingStatus';

// Esperar a que el motor cargue
try {
  (async () => {
    try {
      // Inicializar el sistema de estado de carga
      LoadingStatus.initialize();

      await Engine.start();

      let then = 0;
      let isFirstFrame = true;
      const MAX_DELTA_TIME = 0.1; // Limitar a 100ms (10 FPS mínimo)

      // Iniciar el bucle de renderizado
      function frame(now: number) {
        now *= 0.001;
        let deltaTime = now - then;
        then = now;

        // Saltar el primer frame para evitar big deltaTime
        if (isFirstFrame) {
          isFirstFrame = false;
          requestAnimationFrame(frame);
          return;
        }

        // Clamp deltaTime para evitar saltos grandes
        deltaTime = Math.min(deltaTime, MAX_DELTA_TIME);

        // Solo ejecutar update/render si el engine no está reiniciando
        if (!Engine.isEngineRestarting()) {
          Engine.update(deltaTime);
          Engine.render();
        }
        Time.updateFPSDisplay(deltaTime);

        // Ocultar el loader cuando el motor esté completamente listo y no hay recursos cargando
        if (Engine.isReady()) {
          LoadingStatus.hide();
        }

        requestAnimationFrame(frame);
      }

      requestAnimationFrame(frame);
    } catch (error) {
      console.error('Error starting engine:', error);
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
