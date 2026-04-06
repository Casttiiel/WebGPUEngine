# Plan: EngineTextureRegistry + Material Slots

## Problema

El motor no tiene una forma genérica de referenciar texturas internas (linear depth, env cubemap, SSR result, etc.) desde materiales. Actualmente, cuando un shader necesita una textura del motor, hay que crear bind groups programáticamente (como se hizo con `WATER_SCENE` en group(3)). Esto escala fatal.

**La solución** no requiere ningún cambio en WebGPU — es puramente arquitectura TypeScript.

---

## Restricción relevante de WebGPU

Los bind groups son **inmutables** una vez creados. Sin embargo, esto **no impide** el patrón: los materiales que referencian texturas del motor reconstruyen su bind group en `resize()` (cuando la resolución cambia), no cada frame. Coste: prácticamente cero.

---

## Diseño

### Cambio 1 — `EngineTextureRegistry` (archivo nuevo)

**`src/renderer/core/utils/EngineTextureRegistry.ts`**

Singleton que mapea `nombre canónico → GPUTextureView`. Los sistemas del motor registran sus texturas de salida aquí en `create()` / `resize()`.

```typescript
export const ENGINE_TEXTURES = {
  LINEAR_DEPTH: 'engine:linear_depth',
  ENV_CUBEMAP: 'engine:env_cubemap',
  SSR_RESULT: 'engine:ssr_result',
  GLASS_REFRACTION: 'engine:glass_refraction',
  ACC_LIGHT: 'engine:acc_light',
  GBUFFER_ALBEDO: 'engine:gbuffer_albedo',
  GBUFFER_NORMALS: 'engine:gbuffer_normals',
} as const;

class EngineTextureRegistry {
  static register(name: string, view: GPUTextureView): void;
  static get(name: string): GPUTextureView | null;
  static subscribe(name: string, cb: () => void): () => void; // callback en resize
  static clear(): void; // llamado en Engine restart
}
```

**Puntos de registro:**

| Sistema                                   | Nombre canónico                                                  | Dónde registrar            |
| ----------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| `DeferredRenderer.create()`               | `linear_depth`, `acc_light`, `gbuffer_albedo`, `gbuffer_normals` | tras crear render targets  |
| `AmbientLight` (o `ProceduralSkyCubemap`) | `env_cubemap`                                                    | tras actualizar el cubemap |
| `ScreenSpaceReflections.resize()`         | `ssr_result`                                                     | tras crear `ssrResult` RT  |
| `DeferredRenderer.render()` (tras copiar) | `glass_refraction`                                               | pocos frames, lazy         |

---

### Cambio 2 — `TechniqueMaterialSlot` en el `.tech`

**`src/types/TechniqueData.type.ts`** — addición, sin cambios en campos existentes.

```typescript
export interface TechniqueMaterialSlot {
  name: string; // clave en el .mat "textures"
  binding: number; // @group(1) @binding(N) en WGSL
  type: 'texture2d' | 'texturecube' | 'depth_texture' | 'sampler' | 'uniform';
  defaultValue?: string; // si el .mat no lo provee:
  //   "@engine:linear_depth" → EngineTextureRegistry
  //   "@sampler:simpleSampler" → SamplerLibrary
  //   "white.png" → Texture.getAsync()
}

export type TechniqueDataType = Readonly<{
  vs: string;
  fs: string;
  blend?: BlendModes;
  rs?: RasterizationMode;
  z?: DepthModes;
  writesOn: FragmentShaderTargets;
  uniforms: ReadonlyArray<PipelineBindGroupLayouts>;
  materialSlots?: ReadonlyArray<TechniqueMaterialSlot>; // NUEVO (opcional)
}>;
```

---

### Cambio 3 — `BindGroupFactory`: layout dinámico por técnica

**`src/renderer/core/factories/BindGroupFactory.ts`**

```typescript
static createCustomMaterialLayout(
  slots: ReadonlyArray<TechniqueMaterialSlot>
): GPUBindGroupLayout
```

Convierte cada `TechniqueMaterialSlot` a un `GPUBindGroupLayoutEntry` con visibilidad `FRAGMENT | VERTEX` y el tipo de binding correcto.

---

### Cambio 4 — `Technique.ts`: usar layout dinámico cuando hay `materialSlots`

**`src/renderer/resources/Technique.ts`**

En `createPipelineLayout()`:

- Si la técnica tiene `materialSlots` → llamar a `BindGroupFactory.createCustomMaterialLayout()`
- Si no tiene `materialSlots` → usar el layout fijo `MATERIAL_TEXTURES` (compatible hacia atrás, sin tocar PBR existente)

Añadir accesores:

```typescript
getMaterialSlots(): ReadonlyArray<TechniqueMaterialSlot> | null
getCustomMaterialLayout(): GPUBindGroupLayout | null
```

---

### Cambio 5 — `Material.ts`: bind group flexible

**`src/renderer/resources/Material.ts`**

```typescript
public override async load(): Promise<void> {
  if (this.technique?.getMaterialSlots()) {
    await this.createCustomBindGroup();  // NUEVA ruta
  } else {
    await this.createBindGroup();        // ruta PBR existente, sin tocar
  }
}
```

`createCustomBindGroup()` para cada slot:

| `defaultValue` prefix | Resolución                                                                       |
| --------------------- | -------------------------------------------------------------------------------- |
| `@engine:xxx`         | `EngineTextureRegistry.get('engine:xxx')` + `subscribe()` para rebuild en resize |
| `@sampler:xxx`        | `SamplerLibrary[xxx]`                                                            |
| ruta de archivo       | `Texture.getAsync(path)`                                                         |
| `type === 'uniform'`  | crear `GPUBuffer` con los `MaterialFactors` (igual que ahora)                    |

Si el `.mat` provee un valor para ese slot en `textures`, tiene prioridad sobre `defaultValue`.

El material guarda un `unsubscribe` de cada `EngineTextureRegistry.subscribe()` y lo llama en `dispose()`.

---

### Cambio 6 — Assets actualizados: `water.tech`

```json
{
  "vs": "water/water.vs",
  "fs": "water/water.fs",
  "writesOn": "texture",
  "z": "test_but_no_write",
  "blend": "combinative",
  "rs": "double_sided",
  "uniforms": ["CameraUniforms", "MaterialTextures", "ObjectUniforms"],
  "materialSlots": [
    { "name": "txNoise1", "binding": 0, "type": "texture2d" },
    { "name": "txNoise2", "binding": 1, "type": "texture2d" },
    {
      "name": "txSceneDepth",
      "binding": 2,
      "type": "texture2d",
      "defaultValue": "@engine:linear_depth"
    },
    {
      "name": "txEnvCubemap",
      "binding": 3,
      "type": "texturecube",
      "defaultValue": "@engine:env_cubemap"
    },
    {
      "name": "samplerState",
      "binding": 4,
      "type": "sampler",
      "defaultValue": "@sampler:simpleSampler"
    },
    {
      "name": "envSampler",
      "binding": 5,
      "type": "sampler",
      "defaultValue": "@sampler:environmentCubemap"
    },
    { "name": "factors", "binding": 6, "type": "uniform" }
  ]
}
```

`WaterScene` desaparece de `uniforms`. Ya no hace falta group(3) especial.

---

### Cambio 7 — `water.mat` simplificado

```json
{
  "technique": "water/water.tech",
  "category": "TRANSPARENT",
  "castsShadows": false,
  "baseColorFactor": [0.05, 0.3, 0.7, 0.45],
  "textures": {
    "txNoise1": "textures/noiseRGBTileable.ktx2",
    "txNoise2": "textures/noiseRGBTileable.ktx2"
  }
}
```

`txSceneDepth`, `txEnvCubemap` y samplers usan sus `defaultValue` del `.tech`.

---

### Cambio 8 — `water.fs`: bindings de group(3) → group(1)

Los bindings del motor pasan de `@group(3)` a `@group(1)` con los índices declarados en `materialSlots`. Desaparece el bloque de `// Water scene bindings (group 3)`.

---

### Cambio 9 — Limpieza de la infraestructura WATER_SCENE

Todo el código del hack del group(3) del agua se elimina:

| Archivo                            | Qué se elimina                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `PipelineBindGroupLayouts.enum.ts` | `WATER_SCENE = 'WaterScene'`                                                      |
| `BindGroupFactory.ts`              | `getWaterSceneLayout()` + case en switch                                          |
| `DeferredRenderPasses.ts`          | campo `waterBindGroup`, método `setWaterBindGroup()`, llamada en `execute()`      |
| `RenderPassManager.ts`             | `setTransparentWaterBindGroup()`                                                  |
| `DeferredRenderer.ts`              | campo `waterSceneBindGroup`, método `ensureWaterSceneBindGroup()`, y sus llamadas |
| `RenderManagerV2.ts`               | campo `passGroup3`, método `setPassGroup3()`, uso en `renderKeys()`               |

---

### Cambio 10 (bonus) — Glass OIT con el mismo sistema

El `oitGlassEnvBindGroup` creado programáticamente en `DeferredRenderer` puede migrarse igual:

```json
"materialSlots": [
  { "name": "txEnvCubemap",    "binding": X, "type": "texturecube", "defaultValue": "@engine:env_cubemap" },
  { "name": "txRefraction",    "binding": Y, "type": "texture2d",   "defaultValue": "@engine:glass_refraction" },
  ...
]
```

---

## Scope total

| Tipo                    | Archivos                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Archivo nuevo**       | `EngineTextureRegistry.ts` (~80 líneas)                                               |
| **Modificado (ligero)** | `TechniqueData.type.ts`, `MaterialData.type.ts` (+10 líneas c/u)                      |
| **Modificado (medio)**  | `Technique.ts`, `BindGroupFactory.ts` (~40 líneas c/u)                                |
| **Modificado (mayor)**  | `Material.ts` (~80 líneas nuevas)                                                     |
| **Registros**           | `DeferredRenderer.ts`, `AmbientLight.ts`, `ScreenSpaceReflections.ts` (~5 líneas c/u) |
| **Assets**              | `water.tech`, `water.mat`, `water.fs` (cambios menores)                               |
| **Limpieza**            | 6 archivos, neto **−150 líneas**                                                      |

Las ~30 técnicas y materiales PBR existentes **no se tocan**. La ruta PBR con schema fijo permanece intacta por compatibilidad hacia atrás.

---

## Resultado final

Un material custom con texturas del motor se escribe así, sin una sola línea de código TypeScript extra:

**`assets/techniques/custom/ssr_composit.tech`**

```json
{
  "vs": "fullscreen.vs",
  "fs": "custom/ssr_composit.fs",
  "writesOn": "texture",
  "uniforms": ["CameraUniforms", "MaterialTextures", "ObjectUniforms"],
  "materialSlots": [
    { "name": "txSSR", "binding": 0, "type": "texture2d", "defaultValue": "@engine:ssr_result" },
    { "name": "txAlbedo", "binding": 1, "type": "texture2d" },
    {
      "name": "sampler0",
      "binding": 2,
      "type": "sampler",
      "defaultValue": "@sampler:simpleSampler"
    },
    { "name": "factors", "binding": 3, "type": "uniform" }
  ]
}
```

**`assets/materials/custom_ssr.mat`**

```json
{
  "technique": "custom/ssr_composit.tech",
  "category": "TRANSPARENT",
  "textures": { "txAlbedo": "textures/my_texture.ktx2" }
}
```
