# UI System Refactor Plan

## Objetivo

Reemplazar el sistema UI actual (coordenadas híbridas, pivot centrado, escala no-uniforme, hit detection rota) por un sistema coherente con estas reglas:

- **Origen top-left** en todos los elementos
- **Espacio de referencia fijo** 1920×1080 — coordenadas en el JSON son siempre en ese espacio
- **Un solo factor de escala** `min(w/1920, h/1080)` — sin deformación
- **`pivotX/pivotY`** como fracción 0–1, solo afectan a rotaciones/escala, no al posicionado
- **Hijos** en espacio local del padre, origen = top-left del padre
- **Anchor** solo afecta a widgets raíz, indica desde qué borde de pantalla se calcula `x, y`
- **Hit detection** en physical pixels consistente con las matrices

---

## Schema JSON objetivo

```json
{
  "id": "hud_health",
  "type": "image",
  "x": 40,
  "y": -80,
  "width": 200,
  "height": 40,
  "anchor": "bottom-left",
  "scaleWithScreen": true,
  "pivotX": 0.0,
  "pivotY": 0.0,
  "children": [
    {
      "id": "health_bar",
      "type": "progress",
      "x": 10,
      "y": 10,
      "width": 180,
      "height": 20
    }
  ]
}
```

| Campo             | Tipo    | Default | Descripción                                                                          |
| ----------------- | ------- | ------- | ------------------------------------------------------------------------------------ |
| `x, y`            | number  | 0       | Posición en espacio de referencia (1920×1080). Con anchor, es offset desde el borde. |
| `width, height`   | number  | —       | Tamaño en espacio de referencia.                                                     |
| `anchor`          | string? | none    | Solo en widgets raíz. `"top-left"`, `"bottom-right"`, etc.                           |
| `scaleWithScreen` | boolean | true    | Si false, el elemento no escala (tamaño fijo en physical px vía DPR).                |
| `pivotX, pivotY`  | number  | 0.0     | Fracción 0–1 del tamaño del widget. Solo afecta rotación/escala, no posición.        |
| `rotation`        | number  | 0       | Rotación en radianes alrededor del punto pivot.                                      |
| `visible`         | boolean | true    | —                                                                                    |

---

## Estado actual — problemas concretos

| Problema                            | Fichero(s)                                      | Descripción                                                                                               |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Escala no-uniforme                  | `UIRenderUtils.getUIScaleFactors()`             | Devuelve `[scaleX, scaleY]` separados → deformación en aspect ratios distintos                            |
| DPR mezclado con escala             | `Widget.computeLocal()`                         | Multiplica `baseScale * dpr * scaleX/Y` → el espacio del hijo queda en physical-px con DPR baked          |
| Pivot centrado                      | `UIParser.parseWidgetParams()`                  | Auto-centra (`position = size/2`) si no hay posición explícita → el origen real es el centro, no top-left |
| Anchor dual                         | `ImageWidget.render()`, `ButtonWidget.render()` | `hasAnchor() ? getLocal() : getAbsolute()` → dos rutas de código distintas para el mismo tipo             |
| Hit detection rota                  | `ModuleUI.updateInput()`                        | Mouse en CSS-px, matrices en physical-px → miss en displays con DPR > 1                                   |
| `UICoordinateSystem` duplica lógica | `UICoordinateSystem.ts`                         | Sus métodos están reimplementados en `UIRenderUtils`. No se usa de forma consistente.                     |

---

## Fases de desarrollo

### Fase 1 — `UIRenderUtils`: globalScale + canvasOffset

**Archivos**: `src/renderer/core/UIRenderUtils.ts`

Objetivo: un único `globalScale` y un `canvasOffset` para letterboxing. Todo lo demás habla 1920×1080.

```
globalScale   = min(physW / 1920, physH / 1080)
canvasOffsetX = (physW − 1920 * globalScale) / 2
canvasOffsetY = (physH − 1080 * globalScale) / 2
```

Cambios:

- Eliminar `getUIScaleFactors(): [number, number]`
- Añadir `getGlobalScale(): number`
- Añadir `getCanvasOffset(): [number, number]`
- Quitar el parámetro `dpr` de `updateScreenSize()` — el DPR ya está implícito en los physical pixels del canvas
- Mantener el ortho projection en physical pixels (sin cambios, ya es correcto)

---

### Fase 2 — `WidgetTypes`: nuevo schema TypeScript

**Archivos**: `src/types/WidgetTypes.ts`

Reemplazar `WidgetParams` con la nueva interfaz:

```typescript
// ANTES
interface WidgetParams {
  position?: { x: number; y: number };
  size?: { x: number; y: number };
  scale?: { x: number; y: number };
  pivot?: { x: number; y: number };
  offset?: { x: number; y: number };
  sizeMode?: 'fixed' | 'relative';
  anchor?: string;
}

// DESPUÉS
interface WidgetParams {
  x: number; // top-left en ref space (1920×1080)
  y: number;
  width: number;
  height: number;
  pivotX: number; // 0–1, solo afecta rotación/escala
  pivotY: number;
  rotation: number;
  scaleWithScreen: boolean; // default true
  anchor?: AnchorType; // solo widgets raíz
  visible: boolean;
}
```

- Actualizar `createDefaultWidgetParams()` con los nuevos defaults
- Mantener los tipos de `ButtonStateConfig`, `ImageParams`, `ProgressParams`, etc. sin cambios

---

### Fase 3 — `Widget.computeLocal()`: origen top-left + pivot correcto

**Archivos**: `src/components/ui/Widget.ts`

Nueva fórmula de la matriz local en physical pixels:

```
gs    = globalScale  (o 1 * dpr si scaleWithScreen=false)
ox,oy = canvasOffset (0,0 si scaleWithScreen=false)

// Posición física de la esquina top-left
tlPX = ox + x * gs
tlPY = oy + y * gs

// Centro del quad (el mesh es [-0.5, 0.5] centrado)
cPX  = tlPX + (width  * 0.5) * gs
cPY  = tlPY + (height * 0.5) * gs

// Desplazamiento pivot → centro
dpX  = (0.5 - pivotX) * width  * gs
dpY  = (0.5 - pivotY) * height * gs

// Punto de pivote en physical px
pivPX = tlPX + pivotX * width  * gs
pivPY = tlPY + pivotY * height * gs

local = T(pivPX, pivPY) * R(rotation) * T(dpX, dpY) * S(width*gs, height*gs)
```

Con `pivotX=0, pivotY=0` (default): la esquina top-left del elemento queda exactamente en `(x, y)` ref.  
Con `pivotX=0.5, pivotY=0.5`: la rotación ocurre alrededor del centro (para spinners, etc.).  
Con `scaleWithScreen=false`: `gs = dpr`, `ox = oy = 0` → tamaño fijo independiente de resolución.

Eliminar de `Widget`:

- `private sizeMode`
- `private baseScale`
- `private anchorOffset`
- El hack de `if (sizeMode === 'relative') { dpr * scaleX... }`

---

### Fase 4 — `UIParser`: migrar schema JSON

**Archivos**: `src/core/ui/UIParser.ts`

Cambios en `parseWidgetParams()`:

- Leer `x, y, width, height, pivotX, pivotY, scaleWithScreen`
- **Eliminar** la heurística de auto-centering (`position = size/2 si no hay posición`)
- Mantener compatibilidad legacy: si llega `position: [x, y]` → mapear a `x, y`; si llega `size: [w, h]` → mapear a `width, height`
- Eliminar parseo de `sizeMode`, `scale`, `offset`
- `parseProgressParams`, `parseImageParams`, etc. no cambian

---

### Fase 5 — `UIAnchorSystem`: simplificar a edge-offset

**Archivos**: `src/core/ui/UIAnchorSystem.ts`, `Widget.computeLocal()`

El anchor ya no necesita un sistema paralelo. Solo cambia el punto base desde el que se suman `x, y` en `computeLocal()`:

```typescript
function getAnchorBasePhysical(anchor: AnchorType): [number, number] {
  const gs = UIRenderUtils.getGlobalScale();
  const W = physScreenW,
    H = physScreenH;
  switch (anchor) {
    case 'top-left':
      return [0, 0];
    case 'top-center':
      return [W / 2, 0];
    case 'top-right':
      return [W, 0];
    case 'bottom-left':
      return [0, H];
    case 'bottom-center':
      return [W / 2, H];
    case 'bottom-right':
      return [W, H];
    case 'left-center':
      return [0, H / 2];
    case 'right-center':
      return [W, H / 2];
    default:
      return canvasOffset; // sin anchor = desde top-left del canvas ref
  }
}
```

`x, y` se suman a esa base (escalados por `gs`). El cálculo queda dentro de `computeLocal()` y desaparece el `hasAnchor() ? getLocal() : getAbsolute()` de los widgets.

Los hijos **no tienen anchor** — su base es siempre `(0, 0)` en espacio local del padre.

---

### Fase 6 — `UIInputManager` + `ModuleUI`: hit detection en physical-px

**Archivos**: `src/core/ui/UIInputManager.ts`, `src/modules/core/ModuleUI.ts`

El mouse llega en CSS-px. Las matrices están en physical-px. Fix en `ModuleUI.updateInput()`:

```typescript
const dpr = window.devicePixelRatio || 1;
const mousePhysX = mousePos.x * dpr;
const mousePhysY = mousePos.y * dpr;
```

En `UIInputManager.getWidgetWorldPosition()`:

- Ya extrae `[12], [13]` de la matriz absolute → correcto, está en physical-px
- `Widget.getSize()` debe devolver `[width * gs, height * gs]` (physical-px) en lugar de `baseSize * this.scale` (que mezclaba espacios)

---

### Fase 7 — Eliminar `UICoordinateSystem`

**Archivos**: `src/core/ui/UICoordinateSystem.ts`

Toda su lógica queda absorbida por `UIRenderUtils` y el nuevo `computeLocal()`. Eliminar el fichero y sus importaciones.

---

### Fase 8 — Actualizar JSON de assets UI

**Archivos**: `public/assets/ui/*.json`

- Migrar `position: [x, y]` + `size: [w, h]` → `x, y, width, height`
- Quitar campos `sizeMode`, `pivot` (objeto), `offset`, `scale` (objeto)
- Añadir `scaleWithScreen: false` donde sea necesario (iconos, etc.)
- Verificar que hijos no tengan `anchor`

---

## Orden de trabajo

```
Fase 1  UIRenderUtils      — globalScale + canvasOffset           ← base de todo
Fase 2  WidgetTypes        — nuevo schema TypeScript
Fase 3  Widget             — computeLocal() top-left + pivot      ← núcleo
Fase 4  UIParser           — nuevo schema JSON + compat legacy
Fase 5  UIAnchorSystem     — simplificar a edge-offset
Fase 6  UIInputManager     — fix coordenadas mouse
Fase 7  Eliminar UICoordinateSystem
Fase 8  Migrar JSONs de assets
```

Cada fase es independiente del resto hacia abajo. No empezar una fase hasta que la anterior compile sin errores.
