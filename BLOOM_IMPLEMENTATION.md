# Bloom Implementation - Multiscaling Blur with Compute Shaders

## Overview

Implementación completa de Bloom con multiscaling blur usando compute shaders para máximo rendimiento. El sistema incluye parámetros configurables para controlar la calidad y apariencia del efecto.

## Arquitectura

### 1. BlurComponent (Base)

- **Archivo**: `src/components/render/BlurComponent.ts`
- **Función**: Implementa multiscaling blur con compute shaders
- **Características**:
  - Pirámide de downsampling (reducción de resolución paso a paso)
  - Upsampling con blending aditivo
  - Compute shaders con uniform buffers para parámetros dinámicos
  - Gestión automática de render targets con ping-pong
  - Parámetros configurables para blur strength y blend intensity

### 2. BloomComponent (Derivado)

- **Archivo**: `src/components/render/BloomComponent.ts`
- **Función**: Implementa el efecto bloom completo
- **Características**:
  - Extracción de highlights (partes brillantes)
  - Aplicación de multiscaling blur a los highlights
  - Combinación final con la imagen original (pendiente implementación completa)
  - Parámetros configurables (intensidad, threshold, radius, knee)

## Parámetros Configurables

### BlurComponent (Parámetros de Blur)

#### `maxBlurSteps` (1-8)

- **Controla**: Número de niveles en la pirámide de downsampling
- **Efecto**: Más steps = blur más amplio pero más costoso
- **Default**: 4
- **Uso**: `bloomComponent.setMaxBlurSteps(6)`

#### `blurStrength` (0.1-5.0)

- **Controla**: Amplitud del blur en cada paso
- **Efecto**: Valores más altos = blur más amplio y suave
- **Default**: 1.0
- **Uso**: `bloomComponent.setBlurStrength(2.0)`

#### `blendIntensity` (0.0-2.0)

- **Controla**: Intensidad del blending aditivo en upsampling
- **Efecto**: Valores más altos = bloom más pronunciado
- **Default**: 0.8
- **Uso**: `bloomComponent.setBlendIntensity(1.2)`

### BloomComponent (Parámetros de Bloom)

#### `bloomIntensity` (0.0+)

- **Controla**: Intensidad general del efecto bloom
- **Default**: 1.0
- **Uso**: `bloomComponent.setBloomIntensity(1.5)`

#### `bloomThreshold` (0.0+)

- **Controla**: Umbral para extraer highlights brillantes
- **Efecto**: Valores más altos = solo los elementos más brillantes crean bloom
- **Default**: 1.0
- **Uso**: `bloomComponent.setBloomThreshold(1.2)`

#### `bloomRadius` (0.1-5.0)

- **Controla**: Radio/amplitud del efecto bloom
- **Default**: 1.0
- **Uso**: `bloomComponent.setBloomRadius(2.0)`

#### `bloomKnee` (0.0-1.0)

- **Controla**: Suavidad de la transición del threshold
- **Efecto**: 0 = transición abrupta, 1 = transición muy suave
- **Default**: 0.5
- **Uso**: `bloomComponent.setBloomKnee(0.7)`

## Archivos Creados y Modificados

### Shaders Actualizados

1. **`assets/shaders/bloom_downsample_blur.cs`**

   - Compute shader para downsampling y blur
   - Filtro tent 3x3 para calidad alta
   - Blur gaussiano aproximado con parámetro `blurStrength`
   - **BINDING 3**: Uniform buffer para parámetros

2. **`assets/shaders/bloom_upsample_blend.cs`**

   - Compute shader para upsampling y blending
   - Blending aditivo con control de intensidad dinámico
   - **BINDING 4**: Uniform buffer para parámetros

3. **`assets/shaders/bloom_combine.fs`**
   - Fragment shader para combinación final
   - Combina imagen original + bloom

### Techniques

1. **`assets/techniques/bloom_downsample_blur.tech`**
2. **`assets/techniques/bloom_upsample_blend.tech`**
3. **`assets/techniques/bloom_combine.tech`**
4. **`assets/techniques/bloom_filter.tech`** (ya existía)

## Cómo Usar

### 1. Configuración Básica

```typescript
// Crear componente bloom
const bloomComponent = new BloomComponent();
await bloomComponent.load();

// Configurar parámetros básicos
bloomComponent.setBloomIntensity(1.2); // Más intenso
bloomComponent.setBloomThreshold(0.8); // Más sensible a luces
bloomComponent.setMaxBlurSteps(5); // Blur más amplio
bloomComponent.setBlurStrength(1.5); // Blur más suave
```

### 2. Configuración para Diferentes Estilos

#### Bloom Sutil y Realista

```typescript
bloomComponent.setBloomIntensity(0.8);
bloomComponent.setBloomThreshold(1.5);
bloomComponent.setBloomRadius(1.0);
bloomComponent.setBloomKnee(0.3);
bloomComponent.setMaxBlurSteps(3);
bloomComponent.setBlurStrength(1.0);
bloomComponent.setBlendIntensity(0.6);
```

#### Bloom Dramático y Fantasía

```typescript
bloomComponent.setBloomIntensity(2.0);
bloomComponent.setBloomThreshold(0.5);
bloomComponent.setBloomRadius(3.0);
bloomComponent.setBloomKnee(0.8);
bloomComponent.setMaxBlurSteps(6);
bloomComponent.setBlurStrength(2.5);
bloomComponent.setBlendIntensity(1.5);
```

#### Bloom Amplio y Suave

```typescript
bloomComponent.setBloomIntensity(1.0);
bloomComponent.setBloomThreshold(1.0);
bloomComponent.setBloomRadius(2.0);
bloomComponent.setBloomKnee(0.6);
bloomComponent.setMaxBlurSteps(7);
bloomComponent.setBlurStrength(3.0);
bloomComponent.setBlendIntensity(1.0);
```

### 3. En el DeferredRenderer o ModuleRender

```typescript
// Crear el componente bloom
const bloomComponent = new BloomComponent();
await bloomComponent.load();

// En el render loop, después de la luz acumulada:
public async render(camera: Entity): Promise<GPUTextureView> {
  // ... renderizado normal ...

  // Aplicar bloom si está habilitado
  if (camera.hasComponent('bloom')) {
    const bloom = camera.getComponent('bloom') as BloomComponent;

    // 1. Generar highlights y aplicar blur
    const blurredHighlights = bloom.generateHighlights(
      this.gBufferBindGroup,
      this.rtAccLight.getView()
    );

    // 2. Combinar con imagen original
    const finalResult = bloom.addBloom(
      this.rtAccLight.getView(),
      blurredHighlights
    );

    return finalResult;
  }

  return this.rtAccLight.getView();
}
```

### 2. Configuración de Parámetros

```typescript
// Configurar parámetros de bloom
bloomComponent.setBloomIntensity(1.5); // Intensidad del efecto
bloomComponent.setBloomThreshold(1.0); // Umbral de luminancia
```

### 3. En el QualitySettings

```typescript
// El formato de textura ya está configurado en PostProcessingQualityConfig
const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;
// Usa rgba16float para calidad alta, rgba8unorm para calidad baja
```

## Características Técnicas

### Multiscaling Blur

- **4 niveles de downsampling** (configurable)
- **Filtros de alta calidad**: tent filter + gaussian blur
- **Upsampling con blending**: combinación aditiva progresiva
- **Optimizado para GPU**: workgroups de 16x16

### Gestión de Memoria

- **Render targets automáticos**: creación y destrucción automática
- **Storage texture views**: para compute shaders
- **Texture binding views**: para sampling en shaders
- **Resize automático**: recrea recursos al cambiar resolución

### Integración con Engine

- **Compatible con RenderPassManager**: usa el sistema modular existente
- **Hereda de BlurComponent**: reutiliza infraestructura de blur
- **Quality Settings**: respeta configuración de calidad del engine
- **Bind Group Factory**: usa el sistema de factories existente

## Rendimiento y Optimización

### Impacto en el Rendimiento

#### `maxBlurSteps` - Mayor Impacto

- **1-2 steps**: Muy rápido, blur mínimo
- **3-4 steps**: Balance óptimo (recomendado)
- **5-6 steps**: Bloom amplio, costo moderado
- **7-8 steps**: Bloom muy amplio, costo alto

#### `blurStrength` - Impacto Moderado

- Solo afecta el sampling en shaders
- Rango recomendado: 0.5-2.0 para la mayoría de casos

#### `blendIntensity` - Impacto Mínimo

- Solo afecta aritmética en shaders
- No impacta significativamente el rendimiento

### Recomendaciones por Calidad

#### Calidad Baja (Móviles/GPUs débiles)

```typescript
bloomComponent.setMaxBlurSteps(2);
bloomComponent.setBlurStrength(1.0);
bloomComponent.setBlendIntensity(0.8);
```

#### Calidad Media (PCs estándar)

```typescript
bloomComponent.setMaxBlurSteps(4);
bloomComponent.setBlurStrength(1.5);
bloomComponent.setBlendIntensity(1.0);
```

#### Calidad Alta (PCs potentes)

```typescript
bloomComponent.setMaxBlurSteps(6);
bloomComponent.setBlurStrength(2.0);
bloomComponent.setBlendIntensity(1.2);
```

### Debugging y Tuning

#### Métodos Getter para Debugging

```typescript
console.log('Blur Steps:', bloomComponent.getMaxBlurSteps());
console.log('Blur Strength:', bloomComponent.getBlurStrength());
console.log('Blend Intensity:', bloomComponent.getBlendIntensity());
console.log('Bloom Intensity:', bloomComponent.getBloomIntensity());
console.log('Bloom Threshold:', bloomComponent.getBloomThreshold());
```

#### Ajuste en Tiempo Real

Todos los parámetros pueden ajustarse dinámicamente durante el runtime, permitiendo crear interfaces de usuario para tweaking en tiempo real.

## Estado Actual y Futuras Mejoras

### Implementado ✅

- Multiscaling blur con compute shaders
- Uniform buffers para parámetros dinámicos
- Ping-pong render targets para seguridad
- Extracción de highlights
- Control completo de parámetros
- Documentación completa

### Pendiente 🔄

- Combinación final (original + bloom) con múltiples bind groups
- UI/Debug controls integrados
- Perfiles de calidad automáticos
- Optimizaciones adicionales para móviles

### Uso Recomendado Actual

Por ahora, el sistema devuelve solo el bloom (highlights + blur) sin combinar con la imagen original. Esto permite máxima flexibilidad para integrarlo en diferentes pipelines de post-procesamiento.

## Beneficios

- **Alto rendimiento**: compute shaders vs múltiples render passes
- **Calidad superior**: multiscaling blur vs blur simple
- **Flexible**: parámetros configurables en runtime
- **Escalable**: se adapta automáticamente a diferentes resoluciones
- **Modular**: integración limpia con arquitectura existente
