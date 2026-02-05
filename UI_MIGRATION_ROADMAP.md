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

### **FASE 7: Renderizado WebGPU para UI** 🎨 [4-5 días]

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
