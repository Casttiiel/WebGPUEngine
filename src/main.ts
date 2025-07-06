import { Engine } from './core/engine/Engine';
import { Time } from './core/engine/Time';

// Esperar a que el motor cargue
try {
  await Engine.start();

  let then = 0;

  // Iniciar el bucle de renderizado
  async function frame(now: number) {
    now *= 0.001;
    const deltaTime = now - then;
    then = now;

    // Solo ejecutar update/render si el engine no está reiniciando
    if (!Engine.isEngineRestarting()) {
      Engine.update(deltaTime);
      await Engine.render();
      Time.updateFPSDisplay(deltaTime);
    }

    // Ocultar el loader cuando el motor esté completamente listo
    if (Engine.isReady()) {
      const loader = document.getElementById('loader');
      if (loader && !loader.classList.contains('hidden')) {
        loader.classList.add('hidden');
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
} catch (error) {
  console.error('Error starting engine:', error);
  // Si hay un error, también ocultamos el loader y mostramos un mensaje
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('hidden');
  }
}
