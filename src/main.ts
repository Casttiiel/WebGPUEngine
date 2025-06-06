import { Engine } from "./core/engine/Engine";

// Esperar a que el motor cargue
try {
    await Engine.start();
    // Ocultar el loader cuando el motor haya cargado
    const loader = document.getElementById('loader');
    if (loader) {
        loader.classList.add('hidden');
    }

    // Iniciar el bucle de renderizado
    function frame() {
        Engine.update();
        Engine.render();
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