import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera } from './Camera';

export interface Ray {
  origin: vec3;
  direction: vec3;
}

/**
 * Rayo de mundo que pasa por un punto de pantalla (coordenadas de cliente, p.ej. las de
 * ModuleInput.getMousePosition()). Usado para picking: editor, selección táctica, cursor.
 */
export function screenPointToRay(clientX: number, clientY: number, camera: Camera): Ray {
  const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();

  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = 1 - ((clientY - rect.top) / rect.height) * 2;

  const invProj = mat4.invert(mat4.create(), camera.getProjection());
  const rayView = vec4.transformMat4(vec4.create(), vec4.fromValues(x, y, 1, 1), invProj);
  rayView[0] /= rayView[3];
  rayView[1] /= rayView[3];
  rayView[2] /= rayView[3];
  rayView[3] = 0;

  const invView = mat4.invert(mat4.create(), camera.getView());
  const rayWorld = vec4.transformMat4(vec4.create(), rayView, invView);

  const direction = vec3.normalize(
    vec3.create(),
    vec3.fromValues(rayWorld[0]!, rayWorld[1]!, rayWorld[2]!),
  );
  const origin = mat4.getTranslation(vec3.create(), invView);
  return { origin, direction };
}
