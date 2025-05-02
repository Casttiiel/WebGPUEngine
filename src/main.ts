// src/main.ts

import { Engine } from "./core/engine/Engine";


await Engine.start();

function frame() {
    Engine.update();
    Engine.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);