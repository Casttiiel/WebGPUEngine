# Realtime GI Plan (idTech 8 style, software ray tracing)

Referencia: `tools/SOUSA_SIGGRAPH_2025_Final.pdf` (Tiago Sousa, *idTech 8 Global Illumination*, SIGGRAPH 2025).

Objetivo: GI difusa dinámica (sol, cielo, luces puntuales, emisivos, multi-rebote) sin horneado,
conmutable en caliente con el pipeline actual (sondas F7/F8) sin romper nada de lo existente.

## Estado (2026-11-02)

| Fase | Estado |
|---|---|
| 0 Switch | ✅ `off/realtime/compare`, F9, `?gi=`, menú *Global Illumination*, `QualitySettings.realtimeGI/giQuality` (HIGH/ULTRA activados). Off = módulo destruido |
| 1 BVH | ✅ BLAS por (malla, material) en Workers + TLAS; albedo/emisivo por triángulo; bit de winding desde normales de vértice. Sponza: 228k tris, ~200 ms |
| 2 Sondas | ✅ `auto`: una rejilla de 1 m ajustada al nivel si cabe en 16k sondas (Sponza 22×17×34), si no 4 cascadas 16³ en la cámara; lotes de 4096 sondas/frame; 64 rayos, intercalado (patrón 0,1,0,2,0,1,0,3; histéresis h^(intervalo/2) para que todas reaccionen igual de rápido), toroidal, Chebyshev, recolocación/inactivas, multi-rebote |
| 3 Radiance cache + light grid | ✅ `GIWorldLightGrid`: todas las luces (≤ 256) en 4 cascadas 16³ de 1–8 m en la cámara, ≤ 31 por celda; se reconstruye solo si cambia el conjunto, una luz se mueve > 10 cm, la rejilla se desplaza o cada 30 frames. Sombreado: K reservoirs (K = `lightSamples`, 2) pesados por contribución, exacto si llegan ≤ K luces. `GIRadianceCache`: hash de 2¹⁸ celdas de 25 cm (LOD ×2 cada 6 m de distancia, separadas por la cara dominante de la normal), compactación + actualización de 16k celdas/frame (8k `low`), mezcla ≥ 0,15. Los rayos de sondas leen la celda; solo sombrean en línea las que aún no tienen valor |
| 4 Final gather | ✅ `GIFinalGather`: 1 rayo coseno de 3 m por texel del resolve; impacto → celda de la caché, fuera de alcance → la irradiancia de sondas del píxel × fracción de rayos que escapan (oclusión de contacto + rebote cercano). À-trous 5×5 ×2 + temporal con longitud de historia por texel (bilineal, rechazo por distancia) |
| 5 Integración | ✅ especular renormalizado; niebla froxel (`gi_froxel_ambient.cs`, sustituye al ambiente constante); agua (`ambient_gi.fs` `GI_DIRECT`, sondas por píxel); partículas `LIT` (`GISharedResources`: recursos vacíos con GI apagada → sondas horneadas). El resto de transparentes no usa ambiente |
| 6 Dinámicos | ✅ rígidos (TLAS) y skinned: `GISkinnedBLAS` re-posa en GPU cada frame (skinning por triángulo con la paleta de huesos + refit por niveles); el TLAS usa una caja conservadora por personaje. Los rayos de sondas ignoran a los personajes (`giTraceIgnore`); el gather y las sombras de la caché sí los ven |

Coste medido (Sponza, `?scenario=sponza_gi`, 1280×720 con TSR 0.75, `high` = 64 rayos/sonda):
Trace 1,09 · Integrate 0,45 · Ambient 0,64 · sobrecoste especular +0,5 ms (`low`: 32 rayos, 12³×3).

Fases 3–6 (2026-11-02, mismas condiciones, `?scenario=sponza_gi_lights` con 64 luces; la GPU de
este portátil ajusta la frecuencia a la carga con vsync: medir con la GPU por debajo de 16 ms y
comparar contra un pase que no cambia, p. ej. GI Integrate): Trace 1,1 (2,2 sombreando en línea)
· Cache Update 0,2–0,45 · Gather 0,55–1,1 (según lo cerca que esté la geometría) · Denoise 0,13
· Resolve 0,1 · Light Grid ≈ 0,1 solo al reconstruir · Froxel Ambient ≈ 0,3 · Skin 0,09 (4
personajes, 55k triángulos). Escenarios: `sponza_gi_lights`, `sponza_gi_fx` (agua, ceniza,
niebla), `sponza_gi_chars` (personajes). Vistas de debug nuevas: `radianceCache`, `lightGrid`,
`final`.

Lecciones: el gather no debe muestrear sondas por rayo (cuesta más que el trazado); el refit
de personajes en CPU costaba 1,1 ms/frame de JS → GPU. El trazado usa 11 storage buffers por
pase: `Render.ts` pide el límite del adaptador (el mínimo garantizado es 8).

Cascadas concéntricas en un nivel cerrado = saltos al acercarse (una pared lejana cae en una cascada de 4 m y toma luz de la nave). Por eso `auto` prefiere la rejilla de nivel.

Estabilidad temporal (lecciones): nada de bajar la histéresis ante "cambios grandes" (con pocos
rayos y sol intenso es ruido normal → parpadeo); sondas jóvenes promedian n/(n+1) hasta la
histéresis (si no, las que entran por el borde al moverse arrastran un primer valor sin rebote y
lo lejano se oscurece); clasificación dentro/fuera con media temporal y recolocación solo en las
8 primeras actualizaciones (si no, sondas que se encienden/apagan → picos locales). El especular repite el muestreo de sondas: candidato a
optimizar escribiendo el factor desde `ambient_gi.fs`.

Escena de prueba: `?scenario=sponza_gi` — 6 braseros (sombras + `light_flicker`), 4 apliques, orbe
emisivo con `path_mover`, foco con `light_sweep`, niebla en el patio, vistas en teclas 1–5
(`camera_bookmarks`). Hora del día en el menú *Lighting*.

---

## 0. Decisiones de arquitectura

### No es otro renderer: es un módulo enchufable

Un segundo `DeferredRenderer` duplicaría G-buffer, luces, agua, OIT, SSR, froxels… y habría que
mantener los dos. La GI solo sustituye **un término**: la irradiancia difusa ambiente que hoy sale de
`probeIrradiance()` en `ambient.fs`. Todo lo demás (luces directas, sombras, SSR, transparentes,
post) es idéntico con GI o sin ella.

```
DeferredRenderer.renderAccLight()
  ├─ GI off → ambientLight.renderDiffuse(...)            ← camino actual, intacto
  └─ GI on  → realtimeGI.update(encoder)                 ← trazado, sondas, gather
              realtimeGI.renderDiffuse(...)              ← ambient_gi.fs (mismo contrato de salida)
  ├─ directional / area / tiled / shadowed lights        ← igual
  └─ skybox, clouds                                      ← igual
```

### Reglas del switch

1. **GI apagada = coste cero y comportamiento idéntico.** `RealtimeGI` no se construye hasta la primera
   activación; al apagarla se destruyen sus recursos (VRAM liberada). El único cambio en el camino
   actual es un `if` en `renderAccLight()`.
2. **No se toca `ambient.fs` ni `AmbientLight.ts`** (salvo extraer, si hace falta, el cálculo de `kD` a
   un include común — verificado píxel a píxel con capturas antes/después).
3. **Solo el renderer principal** (`publishTextures === true`) usa GI. El renderer offscreen del
   `ProbeBaker` y el pase de agua (`renderWaterAccLight`) siguen con sondas en la primera versión.
4. **Las reflection probes (especular) se mantienen.** La GI solo aporta difusa hasta la fase 5.
5. **Modos** (`GIMode`):
   - `off` — pipeline actual.
   - `realtime` — GI en tiempo real.
   - `compare` — pantalla partida: a un lado sondas, al otro GI; el divisor se arrastra desde el menú.
     Mismo frame y misma cámara, así que es la mejor forma de juzgar la calidad.
6. **Cómo se activa:** checkbox y selector en el menú *Global Illumination* (ImGui, junto a *Atmosphere*),
   tecla **F9** (cicla off → realtime → compare), URL `?gi=realtime|compare` y vía MCP
   (`eval` → `Engine.getRender()...setGIMode()`). Persistido en `QualitySettings` (`giMode`).
7. **Vistas de debug** (selector en el menú): irradiancia sola, sondas (esferas), impactos de rayos,
   celdas de la radiance cache (color por hash), ecos temporales (contador de historia).

### Ficheros nuevos

```
src/renderer/gi/
  RealtimeGI.ts            fachada: modos, ciclo de vida, update(), renderDiffuse(), renderInMenu()
  GIScene.ts               recoge RenderKeys estáticos → BLAS/TLAS/materiales en GPU, dirty tracking
  BVHBuilder.ts            BVH2 binned-SAH (puro TS, sin DOM)
  bvh.worker.ts            construye los BLAS en un Web Worker
  GIProbeVolumes.ts        cascadas de sondas, atlas octaédrico, scroll toroidal
  GIRadianceCache.ts       hash espacial (fase 3)
  GIFinalGather.ts         gather por píxel, denoise, temporal, upscale (fase 4)
  GIWorldLightGrid.ts      light grid en espacio de mundo (fase 3b)
public/assets/shaders/gi/
  common/bvh.wgsl          recorrido BVH (TLAS→BLAS), intersección rayo-triángulo
  common/gi_probes.wgsl    muestreo de sondas (trilineal + Chebyshev), igual en todos los consumidores
  common/gi_hit_shading.wgsl  sombreado de un impacto (albedo, sol, cielo, luces, emisivo, rebote)
  gi_debug_primary.cs, gi_probe_trace.cs, gi_probe_integrate.cs, gi_probe_classify.cs,
  gi_cache_*.cs, gi_gather*.cs, gi_denoise.cs, gi_temporal.cs, gi_upscale.cs
public/assets/shaders/lighting/ambient_gi.fs (+ .tech)
```

### Puntos de contacto con código existente (lista cerrada)

| Fichero | Cambio |
|---|---|
| `src/renderer/core/pipeline/DeferredRenderer.ts` | campo `realtimeGI`, rama en `renderAccLight()`, `renderGIInMenu()`, resize/destroy |
| `src/core/engine/QualitySettings.ts` | `giMode`, `giQuality` (`low`/`high`) en los presets |
| `src/modules/core/ModuleRender.ts` | ventana *Global Illumination* en el menú, tecla F9, `?gi=` |

Nada más del pipeline actual se toca hasta la fase 5.

---

## Fase 0 — Esqueleto y switch (sin GI todavía)

- `RealtimeGI` con `GIMode`, creación y destrucción lazy, menú, F9, `?gi=`.
- `ambient_gi.fs`: mismo contrato que `ambient.fs` (clear + `ibl + selfIllum`) y mismo `kD`
  (LUT + Kulla-Conty). La irradiancia sale de una textura de GI (de momento constante/debug).
  En modo `compare`, para `uv.x < split` llama a `probeIrradiance()` (el `ProbeSet` también está enlazado).
- **Hecho cuando:** con `off`, la captura MCP es idéntica byte a byte a la de `main`; alternar 50 veces
  no deja fugas (VRAM estable en el profiler).

## Fase 1 — Escena trazable (BVH por software)

**Geometría:** los `RenderKey` de categoría SOLIDS con el mismo filtro que `staticOnly`
(fuera skinned, transparent, particles, water y glass). `Mesh` ya conserva en CPU las posiciones,
los índices y las UVs (`getVertexPositions()`, `getIndices()`), así que no hace falta readback.

**Dos niveles:**
- **BLAS** por `Mesh` único (cacheado por ruta), en espacio de objeto. Binned SAH (12 bins),
  hojas de ≤4 triángulos, construido en un Web Worker para no congelar la carga.
- **TLAS** sobre instancias (matriz inversa de mundo + offsets del BLAS). Se construye en CPU, es barato
  (cientos de instancias) y se reconstruye solo cuando cambia algo (dirty). En la fase 6 servirá para
  rígidos dinámicos.
- Los keys instanciados (`isInstanced`) aportan una instancia TLAS por transform de su storage buffer
  (hay que leerlos de `InstanceManager` en CPU).

**Layout GPU (storage buffers):**
| Buffer | Formato |
|---|---|
| `nodes` | 32 B: `min.xyz, leftOrFirst` / `max.xyz, triCount` (BVH2 plano) |
| `triPos` | 48 B: v0, e1, e2 (aristas precalculadas para Möller-Trumbore) |
| `triAttr` | uv0/uv1/uv2 empaquetadas en f16 + `materialId` (solo se leen en el impacto más cercano) |
| `instances` | `invWorld` (3×vec4), `world` normal (3×vec4), `blasRoot`, `triOffset` |
| `materials` | albedo medio (albedo × baseColorFactor), emisivo, flags |

**Albedo de material (v1):** un compute de una sola pasada lee el mip más pequeño de la textura de albedo de cada
material y lo multiplica por `baseColorFactor`. Más adelante (v2), un atlas de albedo de 64×64 por material
para recuperar variación con las UVs del impacto. WebGPU no tiene bindless ni SBT, así que hay un único
uber-shader de impacto.

**Recorrido:** pila corta privada (`array<u32, 32>`), los dos hijos ordenados por distancia,
`anyHit` para los rayos de sombra.

**Debug:** `gi_debug_primary.cs` lanza un rayo por píxel desde la cámara y pinta la normal, el albedo o la distancia
del impacto. Comparado con el G-buffer deben coincidir, y eso valida el BVH entero.

- **Hecho cuando:** la vista de debug coincide con el G-buffer en Sponza; queda medido el coste de rayos
  primarios a 1080p (objetivo < 3 ms; si no, se optimiza el layout antes de seguir) y el tiempo de build.

## Fase 2 — Sondas en cascada (DDGI-lite). **Primer gran salto visual**

- **Cascadas:** 4 de 16³ (`high`) o 3 de 12³ (`low`). Separación de 1 m en la cascada 0, que se dobla
  en cada una. Centradas en la cámara (en la táctica, en el punto de foco), ajustadas a la rejilla y con
  **direccionamiento toroidal**: al moverse solo se invalidan las rebanadas que entran.
- **Actualización intercalada:** 1 cascada por frame (round-robin) y 32 rayos por sonda (`low`: 16).
  Direcciones con fibonacci esférico rotado al azar en cada frame.
  4096 sondas × 32 = **131k rayos/frame**.
- **Sombreado del impacto** (v1 inline, sin cache):
  `albedo × (sol·visibilidad + cielo SH + luces cercanas + irradiancia_sondas_frame_anterior) + emisivo`.
  La visibilidad del sol sale de la shadow map direccional si el punto cae dentro; si no, de un rayo `anyHit`
  del BVH. Las luces cercanas son las N más próximas a la cámara, elegidas en CPU (≤ 32) y sin sombra en v1.
  Leer las sondas del frame anterior da **multi-rebote infinito**.
  Si el rayo no choca con nada, se usa el cielo (SH del environment).
- **Integración:** atlas octaédrico al estilo DDGI. Irradiancia en 8×8 (+1 borde) `rgba16float`;
  visibilidad en 16×16 (+1) `rg16float` (media y media² → test de Chebyshev contra fugas). Histéresis de ~0,97.
- **Clasificación y recolocación de sondas:** las que quedan dentro de geometría (muchos impactos de cara
  trasera) se desactivan o se desplazan, como en DDGI. Sin esto, Sponza fuga luz por los muros.
- **Muestreo** (`gi_probes.wgsl`): las 8 sondas que rodean el punto, con pesos trilineales, de cara trasera y de
  Chebyshev, más un sesgo por normal y vista. Mezcla entre cascadas en el borde.
- `ambient_gi.fs` usa esto en lugar de `probeIrradiance()`. El horneado F7/F8 deja de hacer falta
  para la difusa.
- **Coste objetivo:** ≤ 1,5 ms en total. **Hecho cuando:** en Sponza el sol que entra por el patio ilumina los
  arcos y los pasillos por rebote, las cortinas tiñen de color su entorno, un cambio de hora se refleja
  en < 1 s y no hay fugas visibles en los muros.

## Fase 3 — World radiance cache (hash espacial) + light grid en mundo

- **Tabla hash:** `keys: array<atomic<u32>>` + `payload` (radiancia empaquetada en
  RGB9E5 sobre `u32` a mano, ya que WebGPU no lo admite como storage, más el frame de último uso). Inserción con
  `atomicCompareExchangeWeak` y sondeo lineal de 8. Celdas de 25 cm con LOD por distancia:
  `lod = exp2(floor(log2(1 + d / LOD_DIST)))`. Hash de (pos cuantizada, lod) y, opcionalmente,
  el octante de la normal (evita mezclar las dos caras de un muro fino).
- **Flujo:** el trazado de sondas guarda el impacto empaquetado (instancia, triángulo, baricéntricas, distancia) e
  inserta o marca la celda en una lista de celdas activas (`atomicAdd`). Un **dispatch indirecto** sombrea solo
  las celdas activas (unas 20k por frame), y cada celda se reutiliza N frames. La integración de sondas lee
  la cache en lugar de sombrear por rayo.
- **3b, light grid en mundo** (como el cascaded light grid de id): 4 cascadas de 16³ con hasta
  32 índices de luz por celda, construido con un compute desde el buffer de luces del `TiledLightManager`.
  Permite **todas** las luces puntuales y focos en el sombreado de impactos, y luego en partículas y vidrio.
- **Hecho cuando:** el coste de sombreado deja de escalar con los rayos, y 50 braseros parpadeando en Sponza
  se notan en la GI sin que el coste se dispare.

## Fase 4 — Final gather por píxel (detalle de normal maps y oclusión fina)

Opcional según el resultado de la fase 2. Las sondas dan GI de baja frecuencia; esta fase añade el contacto.

- 1 rayo por píxel a ½ o ¼ de resolución, coseno sobre la normal del G-buffer, con blue noise.
- **Cadena de caches, sin sombrear nada:**
  1. Pantalla: el impacto reproyectado a la cámara del frame anterior, si la profundidad coincide, lee
     `accLight` del frame anterior.
  2. Radiance cache, si la celda es válida.
  3. Sondas.
- Salida en **SH L1 por píxel** (3 × `rgba16float`), evaluada luego con la normal de alta resolución.
- **Denoise:** bilateral separable (normal, profundidad, distancia del impacto) en memoria compartida.
  **Temporal:** reproyección con la `viewProj` del frame anterior (igual que el SSR: el velocity buffer se
  genera después del deferred), con un contador de historia por píxel y `n_max` ≈ 16.
  **Upscale:** bilateral de 4 taps.
- **Coste objetivo:** ≤ 2,5 ms a 1080p. **Hecho cuando:** las esquinas y bajo los arcos se oscurecen de forma
  natural sin GTAO, y no hay ghosting al girar ni con personajes moviéndose (recordar que los transparentes
  no escriben profundidad ni velocity).

## Fase 5 — Integración con el resto del pipeline

- **Renormalización especular:** `refl *= irradianciaGI / irradianciaSH_de_la_probe` en
  `ambient_specular.fs`, detrás de un define y solo con GI activa. Las reflection probes horneadas recogen
  así la luz y el color dinámicos (adiós a las esquinas que brillan).
- **Froxels:** la niebla toma la luz ambiente de las sondas GI (inyección en el pase de luz de froxels).
  Las partículas `particles` iluminadas ya leen el volumen de froxels, así que la heredan.
- **Agua:** `renderWaterAccLight()` con `ambient_gi`.
- **Transparentes y vidrio:** muestrean `gi_probes.wgsl`.

## Fase 6 — Dinámicos

- Los personajes **reciben** GI desde la fase 2: el ambient es un pase deferred y cubre todos los píxeles.
- Los rígidos dinámicos (cajas con `box_collider` dinámico) pasan al TLAS cada frame. Reconstruir el TLAS en
  CPU es barato y su BLAS no cambia.
- Skinned: no ocluyen en v1. En v2, cápsulas por hueso como proxy en el TLAS (sombra y oclusión aproximadas).

---

## Escenario de prueba: `?scenario=sponza_gi`

`sponza.json` actual es un banco de pruebas variado (terreno, muros de test de sombras, decal de agua…) y
**no se toca**. Se crea una escena dedicada:

- `public/data/scenarios/sponza_gi.json` → `scenes: ["sponza_gi.json"]`, `environment: environment_sponza_gi.json`
- `public/assets/scenes/sponza_gi.json`, `public/data/environment_sponza_gi.json`

**Contenido pensado para lucir GI:**
1. **Sol cenital por el patio** (hora configurable): el suelo iluminado rebota hacia los arcos y la galería
   superior. Es la prueba clásica de rebote.
2. **Cortinas de colores** (ya están en Sponza): sangrado de color rojo, verde y azul sobre las columnas.
3. **Braseros con fuego** en los pasillos laterales, a la sombra: el prefab `tactical/brazier_fire.prefab`
   + `fire_particles.prefab`, con un `PointLight` cálido y un **`LightFlickerComponent` nuevo**
   (intensidad modulada con ruido 1D en dos frecuencias, una lenta "respiración" + crepitar
   rápido; leve jitter de posición de ±3 cm; color que vira de naranja a ámbar con la intensidad). Configurable
   por prefab: `"light_flicker": { "amount": 0.35, "speed": 8, "jitter": 0.03 }`.
4. **Un orbe emisivo que recorre la nave** (spline sencilla): GI dinámica a partir de un emisivo, imposible con
   bake.
5. **Un foco de color que barre** una pared al fondo: mancha de luz que rebota y tiñe el suelo.
6. **Niebla froxel suave** (anisotropía ~0,6, ambient ~0,2) para los rayos de luz bajo los arcos.
7. **Ciclo día/noche** desde el menú (`timeOfDay`): de día manda el sol rebotado y de noche solo los braseros.
   Es la demo más clara de por qué la GI en tiempo real gana al horneado.
8. **Cámaras guardadas** (4 vistas: patio, pasillo con braseros, galería superior, cortinas) con teclas
   1–4, para comparar `off`/`compare`/`realtime` siempre desde el mismo encuadre.

Se monta **en paralelo con la fase 0-1** (con sondas F7/F8 al principio), para tener una referencia
"antes" desde el primer día.

---

## Límites de WebGPU a tener en cuenta

| Tema | Consecuencia |
|---|---|
| Sin RT por hardware | BVH por software. El presupuesto de rayos es el cuello de botella |
| Sin async compute (una sola cola) | Todo es serie. Sumar costes tal cual |
| Sin bindless ni SBT | Material por triángulo + uber-shader; albedo medio o atlas |
| `rgb9e5ufloat` no es storage | Empaquetado manual en `u32` o `rgba16float` |
| Sin atómicos float | Hash con atómicos `u32`; nada de acumular radiancia por atomics |
| `maxStorageBuffersPerShaderStage` = 8 por defecto | Pedir el límite del adaptador al crear el device (suele ser 10+) o fusionar buffers |
| Velocity buffer generado después del deferred | Reproyección temporal con la `viewProj` previa, como `ssr_temporal.cs` |

## Riesgos

- **Rendimiento del BVH en JS y en GPU de gama baja.** Por eso la fase 1 mide antes de seguir. Plan B:
  geometría proxy simplificada (meshoptimizer `simplify` en el worker) solo para el BVH.
- **Fugas a través de muros finos.** Hay que mitigarlas con la clasificación de sondas, Chebyshev, el sesgo
  por normal y el octante de la normal en el hash.
- **Ruido o latencia temporal en luces que parpadean.** La histéresis alta en las sondas suaviza el
  parpadeo. Es aceptable (las sondas son de baja frecuencia), pero el gather de la fase 4 debe reaccionar
  más rápido: bajar la histéresis cuando la luz de una celda cambia mucho.

## Orden de trabajo

0 (switch) → escena `sponza_gi` → 1 (BVH + debug) → **2 (sondas, aquí ya se ve la GI)** → 5 (integración barata) →
3 (cache + light grid) → 4 (gather) → 6 (dinámicos).
