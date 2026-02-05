# 🎨 UI System Migration Roadmap - WebGPU Engine

## 📋 Análisis del Sistema Original (C++/DirectX11)

### Arquitectura Existente

El sistema de UI en la carpeta `old/` tiene la siguiente estructura:

```
UI System (C++/DirectX11)
├── ModuleUI - Coordinador principal
├── Widget System - Sistema de jerarquías
│   ├── Widget Base (transformaciones 2D)
│   ├── Image Widget (texturas/sprites)
│   ├── Text Widget (renderizado de texto)
│   ├── Button Widget (estados/interacción)
│   ├── Progress Widget (barras de progreso)
│   ├── Bar Widget (indicadores)
│   └── Sprite Widget (animación de frames)
├── Controller System - Lógica de interacción
│   └── MenuController (navegación con input)
├── Effect System - Animaciones/efectos visuales
│   ├── FXAnimateUV (animación de coordenadas UV)
│   └── FXScale (escalado animado con interpoladores)
├── Parser System - Carga desde JSON
│   └── UIParser (parsing de widgets, efectos, jerarquías)
└── Render Utils - Renderizado final
    ├── renderBitmap() - Renderizado de sprites/imágenes
    └── renderText() - Renderizado de texto usando bitmap fonts
```

### Características Clave Identificadas

1. **Sistema de Transformaciones 2D**: Matrices local/pivot/absolute con jerarquías padre-hijo
2. **Animaciones con Interpoladores**: Sistema de efectos con distintos tipos de interpolación (linear, cubic, sine, etc.)
3. **Renderizado Ortográfico**: Sistema de coordenadas 2D con ajuste a resolución
4. **Sistema de Estados**: Botones con múltiples estados visuales (normal, hover, pressed)
5. **Widget Classes**: Sistema de registro/activación por tipo con controllers asociados
6. **Lerp System**: Animación de propiedades (alpha, posición, etc.) con tiempo
7. **JSON Driven**: Todo configurable desde archivos JSON externos

---

## 🎯 Estado Actual en Tu Motor

### Archivos Ya Migrados (Parcialmente)

- ✅ `src/components/ui/Widget.ts` - Estructura base del widget
- ✅ `src/core/ui/UIParser.ts` - Parser básico (stub incompleto)
- ✅ `src/types/WidgetTypes.ts` - Tipos TypeScript básicos

### Faltante

- ❌ ModuleUI completo
- ❌ Widgets específicos (Image, Text, Button, Progress, Bar, Sprite)
- ❌ Sistema de efectos (FXAnimateUV, FXScale, etc.)
- ❌ Sistema de controladores (MenuController, etc.)
- ❌ Utilidades de renderizado WebGPU para UI
- ❌ Sistema de transformaciones 2D con gl-matrix
- ❌ Sistema de interpoladores
- ❌ Integración con ModuleRender para renderizado final
- ❌ Shaders específicos para UI (sprites, texto, efectos)
- ❌ Renderizado de texto con bitmap fonts
- ❌ Sistema de eventos de input (hover, click, etc.)

---

## 🗺️ ROADMAP DE MIGRACIÓN

### **FASE 3: Sistema de Efectos** ✨ [2-3 días]

#### 3.1 Base de Efectos

**Objetivo**: Estructura base para efectos visuales.

**Archivos a crear**:

- `src/core/ui/WidgetEffect.ts` - Clase base abstracta

**Tareas**:

- [ ] Interface/clase abstracta `WidgetEffect`
- [ ] Métodos: `start()`, `stop()`, `update(dt)`, `onDeactivate()`
- [ ] Referencia al widget owner
- [ ] Nombre del efecto para búsqueda

#### 3.2 FXAnimateUV

**Objetivo**: Efecto de animación de coordenadas UV.

**Archivos a crear**:

- `src/core/ui/effects/FXAnimateUV.ts`

**Tareas**:

- [ ] Hereda de WidgetEffect
- [ ] Propiedad `speed: vec2` para velocidad de animación
- [ ] Modificación de minUV/maxUV del ImageParams del owner
- [ ] Métodos: `stopUiFx()`, `changeSpeedUV()`, `setMinUV()`, `setMaxUV()`
- [ ] Uso para efectos de agua, fuego, scrolling, etc.

#### 3.3 FXScale

**Objetivo**: Efecto de escalado animado con interpoladores.

**Archivos a crear**:

- `src/core/ui/effects/FXScale.ts`

**Tareas**:

- [ ] Hereda de WidgetEffect
- [ ] Propiedades: `scale: vec2`, `duration: number`, `mode: EMode`
- [ ] Modos: Single, Loop, PingPong
- [ ] Usa sistema de interpoladores
- [ ] Métodos: `setScale()`, `setInitialScale()`, `setTime()`, `changeDuration()`
- [ ] Aplicación sobre el scale del Transform2D

---

### **FASE 4: Sistema de Controladores** 🎮 [2 días]

#### 4.1 Base de Controladores

**Objetivo**: Sistema de lógica de UI independiente del widget.

**Archivos a crear**:

- `src/core/ui/WidgetController.ts` - Clase base abstracta

**Tareas**:

- [ ] Interface/clase abstracta `WidgetController`
- [ ] Método `update(dt: number)`
- [ ] Sistema de registro de controllers en ModuleUI

#### 4.2 MenuController

**Objetivo**: Controller para navegación de menús con teclado/gamepad.

**Archivos a crear**:

- `src/core/ui/controllers/MenuController.ts`

**Tareas**:

- [ ] Hereda de WidgetController
- [ ] Lista de opciones (widgets) navegables
- [ ] Navegación con input (arriba/abajo, enter/espacio)
- [ ] Registro de callbacks por opción
- [ ] Cambio de estado visual de botones (hover/normal)
- [ ] Integración con ModuleInput

---

### **FASE 5: ModuleUI Principal** 🏗️ [3-4 días]

#### 5.1 ModuleUI Core

**Objetivo**: Implementar el módulo central de UI.

**Archivos a crear**:

- `src/modules/core/ModuleUI.ts`

**Tareas**:

- [ ] Hereda de `Module` (patrón establecido en el motor)
- [ ] Gestión de widgets registrados (por nombre y alias)
- [ ] Gestión de widgets activos
- [ ] Gestión de controladores activos
- [ ] Sistema de "Widget Classes" (registerWidgetClass, activateWidgetClass, deactivateWidgetClass)
- [ ] Métodos:
  - `registerWidget(widget)`
  - `activateWidget(name)` / `deactivateWidget(name)`
  - `registerAlias(widget)`
  - `getWidgetByName(name)` / `getWidgetByAlias(alias)`
  - `registerController(controller)` / `unregisterController()`
  - `getWidgetController(type)`
- [ ] Integración con ciclo de vida del motor (start, update, stop)

#### 5.2 Sistema de Lerp/Tweening

**Objetivo**: Sistema de animación de propiedades con interpolación temporal.

**Tareas**:

- [ ] Estructura `WidgetToLerp` con:
  - `element: { value: number }` - Referencia a propiedad
  - `targetValue: number` - Valor objetivo
  - `initialTime: number` - Tiempo de inicio
  - `lerpTime: number` - Duración de la interpolación
  - `currentTime: number` - Tiempo actual
- [ ] Lista de `widgetsToLerp` en ModuleUI
- [ ] Método `lerp(element, targetValue, initialTime, lerpTime)`
- [ ] Procesamiento en `update(dt)` con eliminación automática al completar
- [ ] Uso para fade-in/fade-out de widgets (childAppears)

#### 5.3 Integración con Ciclo del Motor

**Objetivo**: Integrar ModuleUI en el ciclo principal del motor.

**Archivos a modificar**:

- `src/core/engine/Engine.ts`
- `public/data/modules.json`

**Tareas**:

- [ ] Registrar ModuleUI en ModuleManager
- [ ] Añadir a lista de módulos actualizables
- [ ] Configurar en `modules.json`
- [ ] Orden de actualización: después de Input, antes de Render

---

### **FASE 6: Parser y Carga desde JSON** 📄 [2-3 días]

#### 6.1 UIParser Completo

**Objetivo**: Completar el parser de widgets desde JSON.

**Archivos a modificar**:

- `src/core/ui/UIParser.ts`

**Tareas**:

- [ ] Implementar `loadFile(widgetsListFile: string)`
- [ ] Implementar `loadWidget(widgetFile: string)`
- [ ] Implementar `loadFileByName(file: string)`
- [ ] Factory de widgets según tipo:
  - `parseImage(jData)`
  - `parseText(jData)`
  - `parseButton(jData)`
  - `parseProgress(jData)`
  - `parseBar(jData)`
  - `parseSprite(jData)`
- [ ] Parsing de parámetros por tipo (parseParams)
- [ ] Parsing de efectos:
  - `parseFXAnimateUV(jData)`
  - `parseFXScale(jData)`
- [ ] Parsing de interpoladores (`parseInterpolator(type)`)
- [ ] Parsing de jerarquías (children recursivo)
- [ ] Registro automático en ModuleUI

#### 6.2 Estructura de Archivos JSON

**Objetivo**: Definir formato de archivos JSON para UI.

**Archivos a crear** (ejemplos):

- `public/assets/ui/main_menu.json` - Ejemplo de menú principal
- `public/assets/ui/hud.json` - Ejemplo de HUD de juego
- `public/assets/ui/pause_menu.json` - Ejemplo de menú de pausa

**Formato de ejemplo**:

```json
{
  "name": "main_menu_background",
  "alias": "bg_main",
  "type": "image",
  "visible": true,
  "position": [960, 540],
  "scale": [1, 1],
  "pivot": [0.5, 0.5],
  "rotation": 0,
  "imageParams": {
    "texture": "ui/bg_main.png",
    "size": [1920, 1080],
    "color": [1, 1, 1, 1],
    "minUV": [0, 0],
    "maxUV": [1, 1],
    "additive": false
  },
  "effects": [
    {
      "name": "fx_fade_in",
      "type": "scale",
      "scale": [1.2, 1.2],
      "duration": 2.0,
      "mode": "Single",
      "interpolator": "cubic"
    }
  ],
  "children": [
    {
      "name": "title_text",
      "type": "text",
      "position": [0, -200],
      "textParams": {
        "text": "MY GAME",
        "texture": "fonts/arial_bitmap.png",
        "size": [32, 32]
      }
    }
  ]
}
```

---

### **FASE 7: Renderizado WebGPU para UI** 🎨 [4-5 días]

#### 7.1 Shaders para UI

**Objetivo**: Crear shaders específicos para renderizado de UI.

**Archivos a crear**:

- `public/assets/shaders/ui/ui.vs.wgsl` - Vertex shader UI
- `public/assets/shaders/ui/ui.fs.wgsl` - Fragment shader UI
- `public/assets/shaders/ui/ui_additive.fs.wgsl` - Fragment shader aditivo
- `public/assets/shaders/ui/ui_text.fs.wgsl` - Fragment shader para texto

**Características de shaders**:

- [ ] Input: posición 2D, UVs
- [ ] Uniforms: matriz de transformación, color tint, minUV, maxUV
- [ ] Output: color RGBA con blending alpha
- [ ] Soporte para modo aditivo (brillos, efectos)
- [ ] Sampling de texturas con UV remapping

**Ejemplo de vertex shader UI**:

```wgsl
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct UIUniforms {
    transform: mat4x4<f32>,
    tint: vec4<f32>,
    minUV: vec2<f32>,
    maxUV: vec2<f32>,
}

@group(0) @binding(0) var<uniform> ui: UIUniforms;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = ui.transform * vec4<f32>(input.position, 0.0, 1.0);
    output.uv = mix(ui.minUV, ui.maxUV, input.uv);
    return output;
}
```

#### 7.2 Técnicas para UI

**Objetivo**: Crear técnicas (pipelines) para renderizado de UI.

**Archivos a crear**:

- `public/assets/techniques/ui.tech` - Técnica combinativa
- `public/assets/techniques/ui_additive.tech` - Técnica aditiva

**Configuración de técnicas**:

```json
{
  "vs": "ui/ui.vs.wgsl",
  "fs": "ui/ui.fs.wgsl",
  "blend": "ALPHA",
  "z": "ALWAYS",
  "rs": "FILL",
  "writesOn": "SCREEN",
  "uniforms": ["UI_UNIFORMS", "UI_TEXTURE"]
}
```

#### 7.3 UIRenderUtils

**Objetivo**: Utilidades de renderizado de bajo nivel para UI.

**Archivos a crear**:

- `src/renderer/core/UIRenderUtils.ts`

**Tareas**:

- [ ] Clase/funciones estáticas para renderizado
- [ ] `renderBitmap(transform, texture, minUV, maxUV, color, additive)`
- [ ] `renderText(transform, texture, text, size)`
- [ ] Gestión de uniform buffers para UI
- [ ] Activación de técnicas y texturas
- [ ] Uso de mesh `unit_plane_xy` para quads
- [ ] Conversión de coordenadas screen → NDC

**Detalles técnicos**:

```typescript
// Ajuste de coordenadas para WebGPU
const adjustMatrix = mat4.create();
mat4.scale(adjustMatrix, adjustMatrix, [2.0 / width, 2.0 / height, 1.0]);
const finalTransform = mat4.multiply(mat4.create(), worldMatrix, adjustMatrix);
```

#### 7.4 RenderTarget para UI

**Objetivo**: Render target separado para UI overlay.

**Archivos a modificar**:

- `src/renderer/core/DeferredRenderer.ts` (o donde corresponda)

**Tareas**:

- [ ] Crear `rtUIOutput: RenderTarget` (formato RGBA16Float o RGBA8Unorm)
- [ ] Renderizar UI en pase separado después de post-processing
- [ ] Composición final: scene + UI con alpha blending
- [ ] Soporte para MSAA si está habilitado

#### 7.5 Integración con ModuleRender

**Objetivo**: Integrar renderizado de UI en el flujo de ModuleRender.

**Archivos a modificar**:

- `src/modules/core/ModuleRender.ts`

**Tareas**:

- [ ] Método `renderUI()` llamado después de todos los post-processing
- [ ] Activar camera ortográfica para UI (viewport completo)
- [ ] Iterar sobre widgets activos y llamar `doRender()`
- [ ] Composición final UI + Scene
- [ ] Orden: G-Buffer → Lighting → Post-FX → UI → Final Presentation

**Pseudocódigo**:

```typescript
public generateFrame(): void {
  // ... renderizado deferred, lighting, post-fx ...

  // Renderizado de UI
  this.renderUI();

  // Presentación final
  this.presentResult(finalTexture);
}

private renderUI(): void {
  // Setup camera ortográfica
  // Activar rtUIOutput
  // ModuleUI.getInstance().render() → itera widgets activos
  // Componer con resultado anterior
}
```

---

### **FASE 8: Sistema de Eventos de Input** 🖱️ [3-4 días] ⚠️ AMPLIADO

#### 8.1 UIInputManager - Sistema Completo

**Objetivo**: Sistema centralizado para detección de hover, click y eventos de UI.

**Archivos a crear**:

- `src/core/ui/UIInputManager.ts` - **NUEVO** Sistema completo de input

**Tareas**:

- [ ] **Conversión de coordenadas**:
  - `windowToUISpace(windowX, windowY, width, height): vec2`
  - Convierte de coordenadas de ventana a espacio UI normalizado
  - Usa el sistema de coordenadas correcto (0,0 arriba-izq → aspectRatio, 1.0)
- [ ] **Detección de colisión AABB 2D**:
  - `pointInRectangle(point: vec2, center: vec2, size: vec2): boolean`
  - Detección con half-extents para bounds
- [ ] **Extracción de posición desde matrices**:
  - `getWidgetWorldPosition(widget): vec2`
  - Extrae translación de la matriz absolute (elementos [12], [13])
  - Descompone matriz 4x4 para obtener posición real en espacio UI
- [ ] **Sistema de tracking**:
  - `lastHoveredWidget: Widget | null` - Widget bajo el cursor
  - `lastMousePos: vec2` - Posición anterior del mouse
  - Detección de cambios de hover (enter/leave)
- [ ] **Método `checkHover(widget, mouseUIPos): boolean`**:
  - Combina posición mundial + size + detección AABB
  - Devuelve true si el mouse está sobre el widget

**Implementación clave**:

```typescript
export class UIInputManager {
  private lastHoveredWidget: Widget | null = null;
  private lastMousePos: vec2 = vec2.create();

  // Convertir mouse de window space a UI space
  public windowToUISpace(windowX: number, windowY: number, width: number, height: number): vec2 {
    const aspectRatio = width / height;
    const uiX = (windowX / width) * aspectRatio;
    const uiY = windowY / height;
    return vec2.fromValues(uiX, uiY);
  }

  // Detección AABB 2D
  public pointInRectangle(point: vec2, center: vec2, size: vec2): boolean {
    const halfWidth = size[0] * 0.5;
    const halfHeight = size[1] * 0.5;

    return (
      point[0] >= center[0] - halfWidth &&
      point[0] <= center[0] + halfWidth &&
      point[1] >= center[1] - halfHeight &&
      point[1] <= center[1] + halfHeight
    );
  }

  // Extraer posición del widget desde su matriz absolute
  public getWidgetWorldPosition(widget: Widget): vec2 {
    const absolute = widget.getAbsolute(); // mat4
    // Extrae translación: fila 4, columnas 1 y 2 (índices 12 y 13)
    return vec2.fromValues(absolute[12], absolute[13]);
  }

  // Detectar hover en widget
  public checkHover(widget: Widget, mouseUIPos: vec2): boolean {
    const worldPos = this.getWidgetWorldPosition(widget);
    const size = widget.getSize(); // Necesitas añadir este método
    return this.pointInRectangle(mouseUIPos, worldPos, size);
  }

  // Procesar hover/click en frame actual
  public processInput(
    activeWidgets: Widget[],
    mouseUIPos: vec2,
    isMouseActive: boolean,
    isMouseClicked: boolean,
  ): void {
    let hoveredWidget: Widget | null = null;

    // Detectar widget bajo el cursor
    for (const widget of activeWidgets) {
      if (this.checkHover(widget, mouseUIPos)) {
        hoveredWidget = widget;
        break; // Primer widget que colisiona (z-order)
      }
    }

    // Eventos de hover
    if (hoveredWidget !== this.lastHoveredWidget) {
      // Mouse salió del widget anterior
      if (this.lastHoveredWidget) {
        this.lastHoveredWidget.onMouseLeave?.();
      }

      // Mouse entró en nuevo widget
      if (hoveredWidget) {
        hoveredWidget.onMouseEnter?.();
      }

      this.lastHoveredWidget = hoveredWidget;
    }

    // Evento de click
    if (isMouseClicked && hoveredWidget) {
      hoveredWidget.onClick?.();
    }

    this.lastMousePos = mouseUIPos;
  }
}
```

#### 8.2 Detección de Input en Widgets

**Objetivo**: Sistema de eventos para interacción (hover, click, press).

**Archivos a modificar**:

- `src/core/ui/Widget.ts`
- `src/components/ui/widgets/ButtonWidget.ts`

**Tareas**:

- [ ] Añadir método `getSize(): vec2` en Widget para bounds
- [ ] Añadir propiedades de tamaño en Widget (width, height)
- [ ] Callbacks opcionales: `onMouseEnter?()`, `onMouseLeave?()`, `onClick?()`
- [ ] ButtonWidget implementa callbacks para cambiar estado visual:
  - `onMouseEnter()` → cambiar a estado "hover"
  - `onMouseLeave()` → volver a estado "normal"
  - `onClick()` → ejecutar callback registrado
- [ ] Propagación de eventos en jerarquía (opcional: bubbling)

#### 8.3 Integración con ModuleInput

**Objetivo**: Conectar el sistema de input del motor con UI.

**Archivos a modificar**:

- `src/modules/core/ModuleUI.ts`

**Tareas**:

- [ ] Crear instancia de `UIInputManager` en ModuleUI
- [ ] En `update(dt)`:
  - Obtener posición del mouse de ModuleInput
  - Obtener dimensiones de ventana (width, height)
  - Convertir coordenadas usando `windowToUISpace()`
  - Detectar si el mouse se movió (`isMouseActive`)
  - Detectar si se hizo click (`isMouseClicked`)
  - Llamar `inputManager.processInput(activeWidgets, mouseUIPos, ...)`
- [ ] Sistema de tracking: detectar cambios entre frames
- [ ] Gestionar estado "active" del widget con foco (si aplica)

---

### **FASE 9: Mesh y Recursos para UI** 📦 [1-2 días]

#### 9.1 Mesh Unit Plane para UI

**Objetivo**: Mesh básico para renderizar quads de UI.

**Archivos a crear**:

- `public/assets/meshes/ui/unit_plane_xy_ui.obj` - Quad unitario en XY

**Características**:

- Vértices: `[(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)]`
- UVs: `[(0,1), (1,1), (1,0), (0,0)]` (invertir Y si es necesario para WebGPU)
- Índices: `[0,1,2, 0,2,3]`

#### 9.2 Texturas de UI

**Objetivo**: Cargar y gestionar texturas para widgets.

**Tareas**:

- [ ] Crear directorio `public/assets/textures/ui/`
- [ ] Texturas de ejemplo: botones, fondos, iconos
- [ ] Bitmap fonts para texto
- [ ] Integración con sistema de recursos (Texture.get())

---

### **FASE 10: Testing y Ejemplos** 🧪 [2-3 días]

#### 10.1 Escena de Test de UI

**Objetivo**: Crear escena de prueba para validar el sistema.

**Archivos a crear**:

- `public/assets/scenes/ui_test.json` - Escena de test
- `public/assets/ui/test_menu.json` - Ejemplo de menú completo

**Contenido**:

- Menú principal con botones navegables
- HUD con barras de vida/stamina
- Animaciones de entrada/salida
- Efectos visuales (scale, animate UV)
- Texto renderizado

#### 10.2 Integración en Boot

**Objetivo**: Cargar UI en el arranque del motor.

**Archivos a modificar**:

- `src/modules/core/ModuleBoot.ts`

**Tareas**:

- [ ] Cargar widgets de UI desde JSON al inicio
- [ ] Ejemplo: `ModuleUI.getInstance().loadUI('ui/main_menu.json')`
- [ ] Activar widgets necesarios para la escena inicial

#### 10.3 Validación y Depuración

**Objetivo**: Asegurar que todo funciona correctamente.

**Tareas**:

- [ ] Verificar renderizado de todos los tipos de widgets
- [ ] Validar transformaciones 2D (posición, rotación, escala)
- [ ] Probar jerarquías y propagación de transformaciones
- [ ] Validar efectos y animaciones
- [ ] Probar interacción con input (botones, menús)
- [ ] Verificar lerp/tweening de propiedades
- [ ] Debug UI: mostrar bounds de widgets, estados, etc.

---

## 🔧 Detalles Técnicos Importantes

### Conversión de Coordenadas DirectX11 → WebGPU

```typescript
// DirectX11 (origen arriba-izquierda, Y hacia abajo)
// Y: 0 (top) → height (bottom)

// WebGPU NDC (origen centro, Y hacia arriba)
// X: -1 (left) → +1 (right)
// Y: -1 (bottom) → +1 (top)

// Conversión:
function screenToNDC(x: number, y: number, width: number, height: number): vec2 {
  const ndcX = (x / width) * 2.0 - 1.0;
  const ndcY = 1.0 - (y / height) * 2.0; // Invertir Y
  return vec2.fromValues(ndcX, ndcY);
}
```

### Sistema de Blending para UI

```typescript
// Alpha Blending (UI normal)
blend: {
  color: {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add'
  },
  alpha: {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add'
  }
}

// Additive Blending (brillos, efectos)
blend: {
  color: {
    srcFactor: 'src-alpha',
    dstFactor: 'one',
    operation: 'add'
  },
  alpha: {
    srcFactor: 'zero',
    dstFactor: 'one',
    operation: 'add'
  }
}
```

### Depth Testing para UI

```typescript
// UI debe renderizarse sin depth test (siempre visible)
depthStencil: {
  format: 'depth24plus',
  depthWriteEnabled: false,
  depthCompare: 'always'
}
```

---

## 📁 Estructura de Archivos Final

```
src/
├── components/ui/
│   ├── Widget.ts (⭐ con matrices mat4 integradas)
│   └── widgets/
│       ├── ImageWidget.ts
│       ├── TextWidget.ts
│       ├── ButtonWidget.ts
│       ├── ProgressWidget.ts (unificado: bar + progress)
│       └── SpriteWidget.ts (con animación frame-by-frame)
├── core/ui/
│   ├── UICoordinateSystem.ts (⭐ NUEVO - centraliza conversiones)
│   ├── UIInputManager.ts (⭐ NUEVO - detección hover/click)
│   ├── Interpolator.ts (InterpolatorFactory singleton)
│   ├── WidgetEffect.ts
│   ├── WidgetController.ts
│   ├── UIParser.ts
│   ├── effects/
│   │   ├── FXAnimateUV.ts
│   │   ├── FXScale.ts
│   │   ├── FXRotate.ts (opcional)
│   │   └── FXFade.ts (opcional)
│   └── controllers/
│       └── MenuController.ts
├── modules/core/
│   └── ModuleUI.ts
├── renderer/core/
│   └── UIRenderUtils.ts
├── types/
│   └── WidgetTypes.ts (ampliado)
└── (resto de archivos del motor)

public/assets/
├── shaders/ui/
│   ├── ui.vs.wgsl
│   ├── ui.fs.wgsl
│   ├── ui_additive.fs.wgsl
│   └── ui_text.fs.wgsl
├── techniques/
│   ├── ui.tech
│   └── ui_additive.tech
├── meshes/ui/
│   └── unit_plane_xy_ui.obj
├── textures/ui/
│   ├── buttons/
│   ├── backgrounds/
│   ├── icons/
│   └── fonts/
└── ui/
    ├── main_menu.json
    ├── pause_menu.json
    ├── hud.json
    └── test_menu.json
```

---

## 📊 Estimación de Tiempo Total

| Fase      | Descripción                 | Tiempo Estimado | Cambios                                    |
| --------- | --------------------------- | --------------- | ------------------------------------------ |
| 1         | Fundamentos del Sistema UI  | 2-3 días        | +UICoordinateSystem                        |
| 2         | Widgets Fundamentales       | 3-4 días        | +SpriteWidget complejo                     |
| 3         | Sistema de Efectos          | 2-3 días        | Sin cambios                                |
| 4         | Sistema de Controladores    | 2 días          | Sin cambios                                |
| 5         | ModuleUI Principal          | 3-4 días        | Sin cambios                                |
| 6         | Parser y Carga desde JSON   | 2-3 días        | Sin cambios                                |
| 7         | Renderizado WebGPU para UI  | 4-5 días        | Sin cambios                                |
| 8         | Sistema de Eventos de Input | 3-4 días        | ⚠️ **+1-2 días** (UIInputManager completo) |
| 9         | Mesh y Recursos para UI     | 1-2 días        | Sin cambios                                |
| 10        | Testing y Ejemplos          | 2-3 días        | Sin cambios                                |
| **TOTAL** |                             | **24-33 días**  | **+1-2 días vs original**                  |

**Tiempo estimado para desarrollador experimentado**: 5-7 semanas de trabajo a tiempo completo.

### **⚠️ Cambios importantes respecto al roadmap original**:

- ✅ **Sistema de coordenadas corregido**: Origen arriba-izquierda (0,0 → aspectRatio, 1.0), NO centrado
- ✅ **UICoordinateSystem añadido**: Centraliza conversiones windowToUI(), uiToNDC(), getProjectionMatrix()
- ✅ **Interpoladores como singletons**: Implementación mediante InterpolatorFactory estático
- ✅ **SpriteWidget expandido**: Incluye animación frame-by-frame completa con multi-sprite
- ✅ **UIInputManager añadido**: Detección hover completa con pointInRectangle() y conversión de coordenadas
- ✅ **ProgressWidget unificado**: Elimina redundancia de BarWidget (implementación idéntica)

---

## 🎯 Prioridades y Orden Recomendado

### **Enfoque MVP (Minimum Viable Product)** - 1-2 semanas

Si quieres tener algo funcionando rápido, sigue este orden reducido:

1. **Fase 1.1**: Sistema de transformaciones 2D
2. **Fase 2.1**: Widget base completo
3. **Fase 2.2**: ImageWidget
4. **Fase 7.1-7.3**: Shaders y UIRenderUtils básico
5. **Fase 7.5**: Integración con ModuleRender
6. **Fase 5.1**: ModuleUI básico (sin widget classes ni lerp avanzado)
7. **Fase 10.1**: Escena de test simple

Con esto ya podrías renderizar imágenes estáticas en UI.

### **Enfoque Completo** - 4-6 semanas

Sigue las fases en orden numérico para implementar todo el sistema con todas las características.

---

## 🚨 Posibles Problemas y Soluciones

### Problema 1: Coordenadas Invertidas

**Síntoma**: UI aparece invertida verticalmente.
**Solución**: Asegúrate de invertir el eje Y al convertir de coordenadas de pantalla a NDC de WebGPU.

### Problema 2: Blending Incorrecto

**Síntoma**: UI no se ve transparente o colores incorrectos.
**Solución**: Verifica configuración de blend state en la técnica. Usa alpha blending para UI normal.

### Problema 3: Texto No Se Ve

**Síntoma**: TextWidget no renderiza correctamente.
**Solución**: Verifica que el bitmap font tenga layout correcto (8x8 ASCII) y UVs se calculen bien.

### Problema 4: Efectos No Animan

**Síntoma**: FXScale o FXAnimateUV no funcionan.
**Solución**: Verifica que los efectos se actualicen en el `update()` del widget y que el interpolador funcione.

### Problema 5: Input No Funciona

**Síntoma**: Botones no responden a clicks.
**Solución**: Asegúrate de que `containsPoint()` use las coordenadas correctas y que el widget esté activo.

---

## 📚 Recursos Adicionales

- **gl-matrix**: Documentación para operaciones con matrices 2D/3D
- **WebGPU Spec**: Para detalles sobre blending, depth, etc.
- **Documentación del motor**: Ver docs/render.md para integración con pipeline

---

## ✅ Checklist Final

Cuando termines la migración, verifica:

- [ ] Todos los tipos de widgets funcionan (Image, Text, Button, Progress, Bar, Sprite)
- [ ] Sistema de transformaciones 2D correcto con jerarquías
- [ ] Efectos visuales (FXAnimateUV, FXScale) funcionan
- [ ] Controladores (MenuController) permiten navegación
- [ ] Parsing desde JSON funciona correctamente
- [ ] Renderizado WebGPU de UI correcto (sin artefactos)
- [ ] Input (hover, click) funciona en botones
- [ ] Sistema de lerp/tweening funciona para animaciones
- [ ] Widget Classes (register/activate/deactivate) funciona
- [ ] Integración con ModuleRender y ciclo del motor correcta
- [ ] Performance aceptable (UI no impacta FPS significativamente)

---

## 🎉 Resultado Final Esperado

Al completar este roadmap, tendrás:

✅ **Sistema de UI completo y modular** para el motor WebGPU
✅ **Widgets reutilizables** (Image, Text, Button, Progress, Bar, Sprite)
✅ **Sistema de efectos visuales** con animaciones
✅ **Navegación de menús** con input
✅ **Carga desde JSON** data-driven
✅ **Renderizado optimizado** con WebGPU
✅ **Integración total** con el motor existente
✅ **Base sólida** para futuros features de UI

¡Buena suerte con la migración! 🚀
