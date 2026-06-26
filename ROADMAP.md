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

# Weather System — Roadmap de implementación

Sistema de clima dinámico que orquesta en tiempo real los sistemas existentes del motor
(niebla, nubes volumétricas, viento, iluminación direccional, partículas) bajo una capa
unificada de estados y transiciones suaves.

No introduce un nuevo renderer ni un nuevo lenguaje de shaders. Su valor es la **coordinación**
de sistemas ya funcionando y la adición de los efectos visuales que faltan (lluvia, nieve,
rayos, superficies mojadas).

---

## Arquitectura general

```
WeatherSystem (singleton)
├── Estado actual: WeatherState  { clear | cloudy | overcast | rain | heavyRain | storm | fog | snow }
├── Estado objetivo: WeatherState
├── Progreso de transición: t ∈ [0,1]
├── Duración de transición: transitionDuration (seg)
└── Tick(dt): interpolación de todos los parámetros hacia el estado objetivo

WeatherComponent (camera component, prefab "main_camera.prefab")
├── load(data)         — conecta WeatherSystem con los sistemas de render
├── update(dt)         — tick del sistema, aplica valores interpolados a cada subsistema
└── renderInMenu()     — controles en editor: estado actual, intensidad, transición manual

Sistemas controlados:
├── FogScatterComponent       — density, heightFalloff
├── ModuleEnvironmentManager  — cloudCoverage, windSpeed, windAngle
├── DirectionalLightComponent — intensity, color (tinte nublado)
├── RainSystem                — intensidad de partículas, velocidad, dirección
├── SnowSystem                — ídem
├── ThunderSystem             — frecuencia, flash de luz, audio
└── WetSurfaceManager         — factor de humedad global → roughness/reflectivity en materiales
```

Cada `WeatherState` es un objeto que define los valores **objetivo** de todos los parámetros.
`WeatherSystem.tick()` interpola linealmente (o con curvas configurables) desde el estado actual
hacia el objetivo. Todos los subsistemas reciben el valor interpolado, no el target directo.

---

## Phase 1 — Estado y transiciones (núcleo del sistema)

**Archivos nuevos:**
- `src/systems/weather/WeatherSystem.ts`
- `src/systems/weather/WeatherState.ts`
- `src/components/game/WeatherComponent.ts`
- `src/types/WeatherComponentData.type.ts`

### WeatherState

```typescript
interface WeatherStateParams {
  // Niebla
  fogDensity:      number;   // 0.0 – 0.003
  fogHeightFalloff: number;  // 0.02 – 0.15

  // Nubes
  cloudCoverage:   number;   // 0.0 – 1.0
  cloudThickness:  number;   // 0.0 – 1.0

  // Viento
  windSpeed:       number;   // 0.0 – 0.15 (m/s normalizado)
  windAngle:       number;   // 0 – 360 grados

  // Sol
  sunIntensityScale: number; // 0.1 (tormenta) – 1.0 (despejado)
  sunColorTint:    [number, number, number]; // RGB multiplicativo

  // Precipitación
  rainIntensity:   number;   // 0.0 – 1.0
  snowIntensity:   number;   // 0.0 – 1.0

  // Tormenta
  thunderFrequency: number;  // relámpagos por minuto (0 = ninguno)

  // Humedad superficial
  wetness:         number;   // 0.0 – 1.0
}
```

**Presets de estado** (valores de referencia iniciales, ajustables en prefab):

| Estado      | fog   | clouds | wind  | sun   | rain | snow | thunder | wet  |
|-------------|-------|--------|-------|-------|------|------|---------|------|
| Clear       | 0.0003| 0.1    | 0.02  | 1.0   | 0.0  | 0.0  | 0       | 0.0  |
| Cloudy      | 0.0005| 0.45   | 0.04  | 0.75  | 0.0  | 0.0  | 0       | 0.0  |
| Overcast    | 0.001 | 0.75   | 0.05  | 0.45  | 0.0  | 0.0  | 0       | 0.05 |
| Rain        | 0.0015| 0.85   | 0.07  | 0.30  | 0.5  | 0.0  | 0       | 0.5  |
| HeavyRain   | 0.002 | 0.95   | 0.10  | 0.20  | 1.0  | 0.0  | 0       | 1.0  |
| Storm       | 0.002 | 1.0    | 0.15  | 0.15  | 1.0  | 0.0  | 8       | 1.0  |
| Snow        | 0.0008| 0.70   | 0.03  | 0.55  | 0.0  | 1.0  | 0       | 0.0  |
| Fog         | 0.003 | 0.20   | 0.01  | 0.60  | 0.0  | 0.0  | 0       | 0.2  |

### WeatherSystem

```typescript
class WeatherSystem {
  static getInstance(): WeatherSystem

  // Cambio de estado con transición suave
  transitionTo(state: WeatherStateKey, durationSecs: number): void
  setImmediate(state: WeatherStateKey): void

  // Estado interpolado actual (lo que reciben los subsistemas)
  getCurrentParams(): WeatherStateParams

  tick(dt: number): void  // interpolación frame a frame
  isTransitioning(): boolean
  getTransitionProgress(): number  // 0–1
}
```

La interpolación usa `lerp` simple por defecto. El `windAngle` usa interpolación angular
(camino más corto entre ángulos). El `thunderFrequency` se interpola también y se trata
como probabilidad en el sistema de rayos.

### WeatherComponent

Componente de cámara que:
1. Obtiene `WeatherSystem.getCurrentParams()` cada frame
2. Aplica los valores a cada subsistema (niebla, nubes, sol, viento)
3. Activa/desactiva RainSystem y SnowSystem según intensidad > umbral
4. Expone en `renderInMenu()` los controles del weather

**Conexión con sistemas existentes:**
- `FogScatterComponent` — `comp.density = params.fogDensity`, `comp.heightFalloff = params.fogHeightFalloff`
- `ModuleEnvironmentManager` — `env.setCloudCoverage(params.cloudCoverage)`, `env.setWindSpeed(params.windSpeed)`
- `DirectionalLightComponent` — `light.setIntensityScale(params.sunIntensityScale)`, `light.setColorTint(params.sunColorTint)`

**Archivos a modificar:**
- `src/core/loaders/Loader.ts` — registrar `"weather" → WeatherComponent`
- `public/assets/prefabs/cameras/main_camera.prefab` — añadir bloque `"weather": { "initialState": "clear", ... }`
- `src/modules/core/ModuleEnvironmentManager.ts` — exponer setters públicos `setCloudCoverage()`, `setWindSpeed()` si no existen

---

## Phase 2 — Sistema de lluvia

**Archivos nuevos:**
- `src/systems/weather/RainSystem.ts`
- `public/assets/shaders/particles/rain_particle.vs` / `.fs`
- `public/assets/prefabs/vfx/rain_emitter.prefab`

### Partículas de lluvia

La lluvia se implementa como un **volumen de partículas billboard centrado en la cámara**
(no en el mundo), de forma que siempre cubre el área visible sin gestión de streaming.

```
RainSystem
├── Emitter en world space pero reposicionado a cameraPos + (0, roofOffset, 0) cada frame
├── Pool fijo de N partículas (N = 2000 lluvia ligera, 8000 lluvia intensa)
├── Cada partícula: posición aleatoria en caja [-halfExtent, +halfExtent] × [0, height]
├── Velocidad = windDir × windSpeed + vec3(0, -fallSpeed, 0)
├── Cuando y < cameraPos.y - groundOffset → reciclar (nueva posición arriba)
├── Forma: línea elongada en dirección de velocidad (billboard orientado a velocidad)
└── Alpha = intensidad × depthFade (desvanece en superficies cercanas)
```

**Shader de partícula:**
- VS: transforma posición + estira el quad en dirección de velocidad (longitud = speed × stretchFactor)
- FS: gradiente alfa a lo largo del eje largo (más opaco en centro, transparente en extremos)
- Sin sombras, sin iluminación — solo tinting por `scatterColor` de niebla para integración visual

### Splash / impacto en superficies

Efecto secundario simple: cuando una gota llega a `y = groundLevel`, se emite un splash
procedural (billboard circular que se expande en 0.1 s y desaparece). No requiere ray cast;
el `groundLevel` se pasa como uniform (configurable, default 0).

El splash usa la misma textura que las ondas de agua de lluvia (circle ripple). Se puede
reutilizar un atlas de partículas existente.

---

## Phase 3 — Sistema de nieve

**Archivos nuevos:**
- `src/systems/weather/SnowSystem.ts`

Arquitectura idéntica a `RainSystem` con diferencias:

- Partículas más lentas (`fallSpeed` = 1-3 m/s vs 8-15 m/s de lluvia)
- Forma: copo esférico (billboard circular con textura de copo) o quad giratorio
- Movimiento añadido: oscilación senoidal en XZ (flutter) con fase aleatoria por partícula
- Sin splash; en su lugar, ligero "ground accumulation" (ver Phase 5)
- El `windAngle` tiene más influencia visual en nieve que en lluvia (copos lentos)

---

## Phase 4 — Sistema de relámpagos

**Archivos nuevos:**
- `src/systems/weather/ThunderSystem.ts`

Un relámpago es un evento en tres capas:

**Capa 1 — Flash de luz (inmediato)**
Al dispararse el evento, `ThunderSystem` aumenta temporalmente la intensidad del
`DirectionalLightComponent` en un factor grande (×8-15) durante 2-3 frames (≈50 ms),
luego vuelve al valor base. El color vira a azul-blanco (tinte `[0.9, 0.95, 1.0]`).

**Capa 2 — Flash de pantalla (post-process)**
Simultáneamente se activa un fullscreen flash: un quad blanco-semitransparente con
alpha 0.3-0.5 que decae en 3-5 frames. Se renderiza como pass adicional en el pipeline
de post-process, antes del tone mapping.

```typescript
// ThunderFlashComponent (simple, en el mismo fichero ThunderSystem.ts)
// Se activa con triggerFlash(intensity, decaySecs)
// Su pass escribe en el RT de accLight antes de TSR
```

**Capa 3 — Audio (diferido)**
El trueno (sonido) se dispara con un delay = `distancia / 340` ms después del flash.
`distancia` es aleatoria en un rango [200, 2000] m según el estado (tormenta cerca/lejos).
Se integra con el sistema de audio existente si hay uno, o se deja como hook vacío.

**Lógica de frecuencia:**
```typescript
// En ThunderSystem.tick(dt):
this.timer += dt;
const interval = 60.0 / params.thunderFrequency;  // segundos entre rayos
if (this.timer >= interval + Random(-interval*0.4, interval*0.4)) {
  this.triggerLightning();
  this.timer = 0;
}
```

---

## Phase 5 — Superficies mojadas (WetSurfaceManager)

**Archivos nuevos:**
- `src/systems/weather/WetSurfaceManager.ts`

**Archivos a modificar:**
- Shader PBR de materiales (`public/assets/shaders/lighting/`) — añadir uniform `wetness`

### Efecto visual

Las superficies mojadas tienen:
- **Roughness reducida** → más reflectividad especular (suelo brilla como espejo bajo lluvia)
- **Reflectividad base aumentada** → el layer de agua tiene F0 de agua (~0.02)
- **Micro-ondulaciones (ripple normals)** → normal map animado que simula lluvia cayendo en charcos

```wgsl
// En el shader PBR, tras leer las propiedades del material:
let wet = wetness;  // uniform global 0-1
let waterRoughness  = mix(material.roughness, 0.05, wet * saturate(1.0 - material.roughness));
let waterReflective = mix(material.reflectivity, 0.02, wet * 0.6);
// Solo en superficies horizontales (normal.y > umbral):
let rippleNormal = sampleRippleNormal(worldPos.xz, time);
let finalNormal  = normalize(mix(material.normal, rippleNormal, wet * horizontalFactor));
```

`WetSurfaceManager` simplemente mantiene el valor `wetness` global interpolado por
`WeatherSystem` y lo sube a un uniform buffer pequeño (16 bytes) que el shader PBR lee.

### Charcos procedurales

Charcos visibles en zonas planas: se pueden implementar con una máscara basada en la
normal del mundo (`worldNormal.y > 0.85`) y el factor `wetness`. No requiere geometría nueva —
es un blending en el shader PBR entre el material base y un material de agua.

---

## Phase 6 — API de scripting y cinemáticas

**Archivos a modificar:**
- `WeatherSystem.ts` — añadir `onTransitionComplete` callback
- `WeatherComponent.ts` — exponer `triggerWeatherSequence(steps: WeatherSequenceStep[])`

### WeatherSequence

Permite que el código de juego o el sistema de cinemáticas programe secuencias de clima:

```typescript
interface WeatherSequenceStep {
  state:         WeatherStateKey;
  holdSecs:      number;   // cuánto tiempo mantener este estado
  transitionSecs: number;  // duración de la transición HACIA este estado
}

// Ejemplo de secuencia de tormenta cinemática:
WeatherSystem.getInstance().playSequence([
  { state: 'cloudy',    transitionSecs: 30, holdSecs: 60 },
  { state: 'overcast',  transitionSecs: 20, holdSecs: 30 },
  { state: 'storm',     transitionSecs: 15, holdSecs: 120 },
  { state: 'rain',      transitionSecs: 60, holdSecs: 0  },
  { state: 'clear',     transitionSecs: 90, holdSecs: 0  },
]);
```

---

## Resumen de archivos

| Acción    | Archivo |
|-----------|---------|
| Crear     | `src/systems/weather/WeatherSystem.ts` |
| Crear     | `src/systems/weather/WeatherState.ts` |
| Crear     | `src/components/game/WeatherComponent.ts` |
| Crear     | `src/types/WeatherComponentData.type.ts` |
| Crear     | `src/systems/weather/RainSystem.ts` |
| Crear     | `src/systems/weather/SnowSystem.ts` |
| Crear     | `src/systems/weather/ThunderSystem.ts` |
| Crear     | `src/systems/weather/WetSurfaceManager.ts` |
| Crear     | `public/assets/shaders/particles/rain_particle.vs` |
| Crear     | `public/assets/shaders/particles/rain_particle.fs` |
| Modificar | `src/core/loaders/Loader.ts` — registrar WeatherComponent |
| Modificar | `public/assets/prefabs/cameras/main_camera.prefab` — bloque weather |
| Modificar | `src/modules/core/ModuleEnvironmentManager.ts` — setters públicos cloud/wind |
| Modificar | `public/assets/shaders/lighting/tiled_lighting.fs` (o PBR base) — uniform wetness |

---

## Orden de implementación recomendado

```
Phase 1 (núcleo)
  → WeatherState + WeatherSystem (tick + interpolación)
  → WeatherComponent (conexión con fog + nubes + sol + viento existentes)
  → renderInMenu con selector de estado y slider de transición
  → Verificar que los 8 estados transicionan visualmente de forma correcta

Phase 2 (lluvia)
  → RainSystem con pool de partículas centrado en cámara
  → Shader mínimo (línea elongada, alpha fade)
  → Splash de impacto (opcional, segunda iteración)

Phase 4 (relámpagos)
  → ThunderSystem con flash de luz direccional
  → Flash de pantalla (fullscreen quad)
  → Audio hook (dejar preparado aunque no haya audio aún)

Phase 5 (superficies mojadas)
  → WetSurfaceManager → uniform buffer
  → Roughness/reflectivity en shader PBR
  → Ripple normals (segunda iteración)

Phase 3 (nieve)
  → SnowSystem basado en RainSystem con ajustes de velocidad/flutter

Phase 6 (scripting)
  → WeatherSequence API
  → Integración con sistema de cinemáticas si existe
```

**El checkpoint más importante es al final de Phase 1**: si los 8 estados transicionan
correctamente y los sistemas existentes (niebla, nubes, viento) responden, el núcleo del
weather system está completo. Las phases siguientes añaden efectos pero no bloquean el uso
del sistema para scripting y diseño de niveles.
