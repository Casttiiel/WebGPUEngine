# Combat AI — Roadmap de mejoras

Síntesis de principios de diseño de combate H&S (God of War, DMC, Batman Arkham, Bayonetta, Sekiro)
aplicados a este motor. Ordenado de más fácil a más complejo de implementar.

---

## Estado actual (implementado)

- **Token system** — solo N enemigos atacan simultáneamente (CombatDirectorComponent)
- **Global pace timer** — pausa entre olas de ataque (attackPaceMs)
- **Cooldown individual** — cada enemigo espera X segundos tras su propio ataque
- **Selección por puntuación** — director elige al mejor candidato (distancia + espera + penalización por repetición)
- **Percepción H&S** — primera detección con FOV+LOS, luego solo radio de deaggro (25 m)
- **CircleStrafe** — enemigos orbitan al jugador con sector encirclement mientras esperan
- **Roles** — AGGRESSOR / FLANKER / HARASSER / SUPPORT (asignación automática en token)
- **Presión escalada** — agresividad sube cuando el jugador lleva tiempo sin recibir daño

---

## Tier 1 — Muy fácil (parámetros o < 20 líneas de código)

---

### 2. Presets de dificultad en el director

```
Fácil:       maxAttackers=1, attackPaceMs=8000, aggressiveness=0.2
Normal:      maxAttackers=1, attackPaceMs=5000, aggressiveness=0.5
Difícil:     maxAttackers=2, attackPaceMs=300,  aggressiveness=0.75
Muy difícil: maxAttackers=3, attackPaceMs=1500,  aggressiveness=1.0
```

El director ya tiene todos estos parámetros. Solo hace falta un método `setDifficulty(level)`.

---

### 3. Offsets aleatorios en posición deseada

> _"desiredPosition += RandomOffset()"_ — Naughty Dog / Santa Monica

Añadir un pequeño ruido (0.2–0.8 m) a la posición objetivo de cada enemigo al calcularse.
Resultado: la formación deja de parecer militar. Se implementa en un sitio: `CircleStrafeAction`.

---

### 4. Distancia preferida variable por enemigo

```
distancePreference = Random(1.8m, 3.2m)
```

Cada instancia de `CircleStrafeAction` elige su `preferredRange` dentro de un rango en lugar de un valor fijo.
Unos se acercan demasiado, otros se quedan atrás. Orgánico sin código extra.

---

### 5. Tiempo de compromiso en decisiones de dirección

> _"commitmentTime = Random(1s, 3s)"_ — evita el efecto zigzag frame a frame

Una vez que `CircleStrafeAction` elige una dirección de órbita, mantenerla durante `commitmentTime`
antes de recalcular. Ya hay `K_STRAFE_DIR` y `K_STRAFE_FLIP` en el Blackboard — solo ajustar el intervalo.

---

## Tier 2 — Fácil (campo nuevo o método pequeño)

### 6. Decisiones asíncronas (relojes mentales independientes)

> _"EnemyA piensa cada 0.3 s, EnemyB cada 0.7 s, EnemyC cada 0.5 s"_

El BT ya corre cada frame. Añadir un `thinkInterval = Random(0.1s, 0.4s)` en `EnemyControllerComponent`
que regule cada cuánto se evalúa el árbol completo. Elimina el efecto "todos deciden a la vez"
que produce sincronización artificial.

**Archivo:** `EnemyControllerComponent.update()` — throttle de `tree.step()`.

---

### 7. Reserva de slot durante varios segundos

> _"slotReservationDuration = 2-5 s"_ — el enemigo mantiene su ángulo aunque ya no sea ideal

`CircleStrafeAction` recalcula el sector óptimo cada 0.6 s. Ampliar a 2-4 s aleatorios.
Cuando el jugador se mueve bruscamente, los enemigos **no se reorganizan inmediatamente** —
quedan mal colocados brevemente y se reajustan poco a poco. Mucho más natural. Y ademas puede intercambiar slots para que sea mas natural.

**Archivo:** `CircleStrafeAction.ts` — cambiar `K_POS_TIME` interval.

---

### 8. Latencia de reacción ante cambios bruscos del jugador

> _"reactionDelay = Random(0.2f, 1.2f)"_ — la naturaleza tiene latencia

Cuando el jugador teletransporta, hace dash o cambia de posición más de N metros en un tick,
los enemigos no actualizan `playerPosition` en su Blackboard inmediatamente — introducir
un delay aleatorio antes de escribir la nueva posición.

**Archivo:** `PerceptionComponent.runChecks()` — delay en la escritura de `playerPosition` tras cambios grandes.

---

### 9. Presupuesto de amenaza (Threat Budget)

> _"Threat Budget = 100 | Golpe = 25, Carga = 40, Proyectil = 20, Especial = 60"_

El director mantiene un pool de "amenaza activa". Cada tipo de ataque tiene un coste.
Antes de conceder un token, el director comprueba si el coste cabe en el presupuesto restante.
Cuando el ataque termina, el coste se devuelve al pool.

Esto limita automáticamente las combinaciones peligrosas sin reglas hardcoded:
`60 + 60 = 120 > 100` → bloqueado. `25 + 25 + 20 = 70 ≤ 100` → permitido.

**Archivos:** `CombatDirectorComponent.ts` (campo `threatBudget`, coste por tipo),
`EnemyControllerComponent.ts` (`getAttackThreatCost(): number` override en subclases).

---

## Tier 3 — Medio (sistema nuevo, ~100-200 líneas)

---

### 14. Imperfección deliberada

> _"La IA perfecta parece falsa"_

Introducir errores controlados

Nada de esto requiere lógica compleja — son rolls aleatorios en puntos clave del BT.

---

## Tier 4 — Complejo (arquitectura nueva, > 200 líneas)

### 15. Sistema de slots posicionales

> _"Posición A = 78 | Posición B = 81 | Posición C = 75 → elige B"_

En lugar de orbitar libremente, el director mantiene N slots numerados alrededor del jugador
(por ejemplo, 8 posiciones a 45° de separación). Cada enemigo **reserva** un slot y navega
hacia él. Los slots se recalculan cada 2-5 s.

Beneficios: los enemigos no se solapan, el flanqueo es predecible y legible para el jugador,
el director controla la geometría del combate.

**Archivos nuevos:** `CombatSlotManager.ts`, integración en `CombatDirectorComponent`.

---

---

### 17. Presupuesto de presión continuo (Pressure Budget dinámico)

> _"Cada segundo el director decide: ¿puedo gastar más presión?"_

Evolución del Threat Budget (Tier 2): el presupuesto se regenera con el tiempo a una tasa
función de la dificultad. Los ataques no devuelven su coste al terminar — se amortiza
durante 2-3 s, produciendo rachas de alta presión seguidas de respiros naturales sin
que el diseñador tenga que hardcodear la cadencia.

---

## Principios generales (guían el diseño, no son código)

| Regla                              | Valor orientativo                                                           |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Máx. atacantes simultáneos         | 1-2 (normal), 3 (difícil)                                                   |
| Cooldown global entre olas         | 1.5–3 s                                                                     |
| Cooldown individual por enemigo    | 3–6 s (varía por tipo)                                                      |
| Proporción presión activa / órbita | 30% atacando, 70% rodeando/esperando                                        |
| Tiempo entre amenazas relevantes   | 1.5–3 s (ataque, carga, proyectil…)                                         |
| Latencia de reacción de enemigos   | 1.0–2.5 s ante cambios grandes del jugador                                  |
| Objetivo de diseño                 | El jugador nunca está seguro, pero casi siempre tiene una respuesta posible |

---

---

# Screen Space Fog Multi-Scatter — Roadmap de implementación

Sistema completamente independiente del froxel volumetric. No depende de ningún sistema de niebla existente.

Dos efectos físicamente motivados:
- **Efecto 1 (scene blur):** objetos dentro de la niebla pierden nitidez en proporción a la transmittance real (no a la distancia). Un objeto a 30 m detrás de niebla densa se ve borroso; uno a 30 m con cielo despejado, no.
- **Efecto 2 (lateral scatter):** la luz inside el volumen sangra lateralmente — el paso de zona iluminada a zona en sombra dentro de la niebla es un gradiente suave, no un corte duro.

El sistema genera su propio `fogHalfRT` (media resolución, RGBA: RGB=scatter acumulado, A=transmittance) mediante un raymarch screen-space propio. Todo el pipeline vive en un único componente de cámara.

---

## Step 0 — Leer los componentes de referencia

**Archivos a leer (sin modificar):**
- `src/components/render/GodRaysComponent.ts` — patrón de raymarch screen-space con shadow maps + kawase blur + composite
- `src/components/vfx/AtmosphericFogComponent.ts` — patrón de fog analítico con RenderPassManager, uniforms, bind group cache
- `src/components/render/BlurGaussianComponent.ts` — patrón de blur gaussiano separable reutilizable
- `public/assets/shaders/post-processing/gaussian_blur.fs` — shader de blur existente como base

Objetivo: entender exactamente cómo se crean los RenderTargets, cómo se gestiona el RenderPassManager, cómo se cachean los bind groups, y cómo se registran los componentes en `Loader.ts`. Aplicar estos mismos patrones al nuevo componente.

---

## Step 1 — Shader de raymarch screen-space

**Archivo nuevo:** `public/assets/shaders/post-processing/fog_scatter_raymarch.fs`

Raymarch a media resolución que reconstruye rayos de cámara desde el depth buffer del GBuffer.

```
Inputs (bindings):
  - txLinearDepth   — depth lineal del GBuffer (para reconstruir posición de mundo y saber dónde parar)
  - txShadowMap     — shadow map del directional light (para saber si cada step está iluminado)
  - uCamera         — uniforms de cámara (proyección inversa, posición, far plane)
  - uDirLight       — dirección + color del sol
  - uFogParams      — density, height falloff, scatter color, step count, near/far
  - uBlueNoise      — textura de ruido para dithering del raymarch (evita banding)

Output: vec4<f32>
  RGB = scatter acumulado (luz in-scattered × niebla × visibilidad de sombra)
  A   = transmittance (1 = sin niebla, 0 = completamente opaco)
```

El raymarch avanza desde la posición de cámara hasta `min(hitDepth, fogFarPlane)` en N steps:
```wgsl
for step in 0..numSteps:
  worldPos = cameraPos + rayDir * (stepT + blueNoiseDither)
  fogDensity = evalHeightFog(worldPos)   // densidad = e^(-height * falloff)
  shadowVis = sampleShadowMap(worldPos)  // 0 o 1 (PCF suave)
  scatter += fogDensity * scatterColor * dirLightColor * shadowVis * stepSize
  transmittance *= exp(-fogDensity * extinctionCoeff * stepSize)
```

Parámetros del raymarch: `numSteps` (16-32), `fogDensity`, `fogHeightBase`, `fogHeightFalloff`, `scatterColor`, `extinctionCoeff`, `nearPlane`, `farPlane`.

**Nota de coste:** a 1/2 resolución con 16-24 steps y shadow map PCF, es comparable al GodRaysComponent. El blue noise + TSR hacen el trabajo de alisado temporal.

---

## Step 2 — Shader de blur bilateral con depth

**Archivo nuevo:** `public/assets/shaders/post-processing/fog_bilateral_blur.fs`

Gaussian separable con weight por similitud de profundidad. Basado en `gaussian_blur.fs` con un binding extra para el depth.

```wgsl
// Por cada sample vecino en la dirección del blur:
let depthDiff   = abs(sampleLinearDepth - centerLinearDepth);
let depthWeight = exp(-depthDiff * params.depthSigma);
totalWeight    += gaussianWeight * depthWeight;
accum          += textureSample(...) * gaussianWeight * depthWeight;
output          = accum / totalWeight;
```

Uniforme: `direction (vec2)`, `radius (f32)`, `depthSigma (f32)`.

Sirve para dos usos sin cambios:
- **Blur de fogHalf** (RGBA, radio pequeño 1-2 px en media res) — lateral scatter
- **Blur de sceneColor** (RGB, radio mayor 4-6 px en cuarto de res) — scene blur por transmittance

El `depthSigma` controla si el blur cruza bordes geométricos o no. Valores útiles: `~5.0` para fog (bordes suaves), `~1.0` para scene blur (no mezclar fondo lejano con objetos cercanos).

---

## Step 3 — Shader de composición final

**Archivo nuevo:** `public/assets/shaders/post-processing/fog_multiscatter_compose.fs`

```wgsl
// Bindings:
// txScene          — sceneColor original (HDR antes de fog)
// txSceneBlurred   — sceneColor con blur bilateral a cuarto de res
// txFogHalf        — output del raymarch (RGB=scatter, A=transmittance)
// txFogHalfBlurred — fogHalf con blur bilateral
// uParams          — lateralScatterStrength, multiScatterStrength

let fogHalf        = textureSample(txFogHalf, ..., uv);
let fogHalfBlurred = textureSample(txFogHalfBlurred, ..., uv);
let sceneColor     = textureSample(txScene, ..., uv).rgb;
let sceneBlurred   = textureSample(txSceneBlurred, ..., uv).rgb;

let transmittance = fogHalf.a;

// Efecto 2: lateral scatter
let fogScatter = mix(fogHalf.rgb, fogHalfBlurred.rgb, params.lateralScatterStrength);

// Efecto 1: scene blur proporcional a niebla real
let blurWeight = saturate((1.0 - transmittance) * params.multiScatterStrength);
let baseColor  = mix(sceneColor, sceneBlurred, blurWeight);

// Composición estándar
output = vec4<f32>(baseColor * transmittance + fogScatter, 1.0);
```

Uniforme `FogMultiScatterParams` (16 bytes): `lateralScatterStrength`, `multiScatterStrength`, `enabled (f32)`, `pad`.

---

## Step 4 — Crear los archivos `.tech`

**Archivos nuevos:** basarse en `gaussian_blur.tech` como referencia de estructura.

- `public/assets/techniques/post-processing/fog_scatter_raymarch.tech`
  - Sin depth stencil, sin blend (escribe scatter+transmittance directo a fogHalfRT)
- `public/assets/techniques/post-processing/fog_bilateral_blur.tech`
  - Sin blend, sin depth
- `public/assets/techniques/post-processing/fog_multiscatter_compose.tech`
  - Sin blend, escribe el resultado final directo

---

## Step 5 — Crear `FogMultiScatterComponent`

**Archivo nuevo:** `src/components/render/FogMultiScatterComponent.ts`

Combina el raymarch + blurs + compose en un único componente de cámara, igual que `GodRaysComponent` combina su raymarch + kawase + composite.

```
FogMultiScatterComponent extends Component
│
├── RenderTargets
│     ├── fogHalfRT          (Render.width/2 × Render.height/2, rgba16float)  ← output del raymarch
│     ├── fogHalfBlurH       (misma res, rgba16float)  ← horizontal bilateral
│     ├── fogHalfBlurred     (misma res, rgba16float)  ← vertical bilateral
│     ├── sceneBlurH         (Render.width/4 × Render.height/4, rgba16float)
│     ├── sceneBlurred       (misma res, rgba16float)
│     └── resultRT           (Render.width × Render.height, rgba16float)  ← output final
│
├── load(data)
│     ├── Cargar fog_scatter_raymarch.tech
│     ├── Cargar fog_bilateral_blur.tech
│     ├── Cargar fog_multiscatter_compose.tech
│     ├── Crear RenderTargets
│     ├── Crear uniform buffers (fogParams + multiScatterParams)
│     └── Crear bind group cache (igual que AtmosphericFogComponent)
│
├── render(sceneView, gBufferBindGroup, dirLightComponent): GPUTextureView
│     ├── Pass 1: fog_scatter_raymarch  → fogHalfRT          (genera scatter+transmittance)
│     ├── Pass 2: bilateral blur H      → fogHalfBlurH        (lateral scatter H)
│     ├── Pass 3: bilateral blur V      → fogHalfBlurred      (lateral scatter V)
│     ├── Pass 4: bilateral blur H      → sceneBlurH          (scene blur H, usa sceneView)
│     ├── Pass 5: bilateral blur V      → sceneBlurred        (scene blur V)
│     └── Pass 6: compose               → resultRT            (efecto 1 + efecto 2 + fog)
│
├── resize()    — destruye y recrea todos los RenderTargets + invalida bind group cache
│
└── renderInMenu()
      ├── enabled
      ├── fog density, height base, height falloff, scatter color
      ├── num raymarch steps (8 / 16 / 32)
      ├── lateralScatterStrength (0.0 → 1.0, default 0.45)
      └── multiScatterStrength   (0.0 → 1.0, default 0.6)
```

---

## Step 6 — Wiring en DeferredRenderer

**Archivo:** `src/renderer/core/pipeline/DeferredRenderer.ts`

El componente se invoca al final del pipeline de iluminación, antes de que `rtAccLight` salga al pipeline de post-process (TSR, bloom, tone mapping).

```typescript
// Al final de renderScene(), después de SSR + ambient specular:
const fogMultiScatter = camera.getComponent('fog_multi_scatter') as FogMultiScatterComponent | null;
if (fogMultiScatter?.isEnabled()) {
  const dirLight = Engine.getEntities()
    .getObjectManagerByName('directional_light')?.getList()[0] as DirectionalLightComponent;
  return fogMultiScatter.render(
    this.rtAccLight.getView(),
    this.gBufferBindGroup,        // contiene linearDepth para el raymarch
    dirLight,
  );
}
return this.rtAccLight.getView();
```

El resultado de `fogMultiScatter.render()` reemplaza `rtAccLight.getView()` como input del resto del pipeline (TSR, bloom, tone mapping). Si el componente no existe o está desactivado, el pipeline no cambia.

---

## Step 7 — Registro y prefab

**Archivos:** `src/core/loaders/Loader.ts`, `public/assets/prefabs/cameras/main_camera.prefab`

En `Loader.ts`, añadir `"fog_multi_scatter" → FogMultiScatterComponent` donde están el resto de componentes de render de cámara.

En `main_camera.prefab`:
```json
"fog_multi_scatter": {
  "density": 0.012,
  "heightBase": 0.0,
  "heightFalloff": 0.08,
  "scatterColor": [0.85, 0.92, 1.0],
  "numSteps": 16,
  "lateralScatterStrength": 0.45,
  "multiScatterStrength": 0.6
}
```

---

## Resumen de archivos

| Acción    | Archivo |
|-----------|---------|
| Crear     | `src/components/render/FogMultiScatterComponent.ts` |
| Crear     | `public/assets/shaders/post-processing/fog_scatter_raymarch.fs` |
| Crear     | `public/assets/shaders/post-processing/fog_bilateral_blur.fs` |
| Crear     | `public/assets/shaders/post-processing/fog_multiscatter_compose.fs` |
| Crear     | `public/assets/techniques/post-processing/fog_scatter_raymarch.tech` |
| Crear     | `public/assets/techniques/post-processing/fog_bilateral_blur.tech` |
| Crear     | `public/assets/techniques/post-processing/fog_multiscatter_compose.tech` |
| Modificar | `src/renderer/core/pipeline/DeferredRenderer.ts` — wiring al final de renderScene() |
| Modificar | `src/core/loaders/Loader.ts` — registro del componente |
| Modificar | `public/assets/prefabs/cameras/main_camera.prefab` — añadir fog_multi_scatter |

**Cero dependencias del sistema froxel.** Toda la información de niebla (scatter, transmittance) la genera el raymarch propio.

**Orden recomendado:** Steps 0-1 (shader del raymarch + test visual de fogHalfRT) → Steps 2-3 (blur + compose) → Step 4 (.tech) → Step 5 (componente) → Steps 6-7 (wiring). El test visual del fogHalfRT es el checkpoint más importante: si el raymarch genera scatter y transmittance correctamente, el resto del sistema sigue de forma directa.
