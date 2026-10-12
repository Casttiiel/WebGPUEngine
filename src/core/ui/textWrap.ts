import { UIRenderUtils } from '../../renderer/core/UIRenderUtils';

/** Fuente por defecto de la UI (la de TextWidget). */
export const UI_FONT = 'ui/fonts/ui_font.png';

/**
 * Parte un texto en líneas que quepan en `width` px de referencia con letra de `size` px
 * (los TextWidget son de una sola línea). Sin métricas aún, aproxima.
 */
export function wrapText(text: string, size: number, width: number, font = UI_FONT): string[] {
  const metrics = UIRenderUtils.getFontMetrics(font) ?? null;
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && UIRenderUtils.measureText(candidate, size, metrics) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
