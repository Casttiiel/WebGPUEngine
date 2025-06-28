import { Engine } from './core/engine/Engine';
import { Time } from './core/engine/Time';

// Esperar a que el motor cargue
try {
  await Engine.start();
  // Ocultar el loader cuando el motor haya cargado
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('hidden');
  }

  let then = 0;

  // Iniciar el bucle de renderizado
  async function frame(now: number) {
    now *= 0.001;
    const deltaTime = now - then;
    then = now;

    Engine.update(deltaTime);
    await Engine.render();

    Time.updateFPSDisplay(deltaTime);
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
