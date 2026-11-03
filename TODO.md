## HITO 6 — Motor: animación, rendimiento y trazado

Trabajo de motor, en paralelo a los hitos de juego. Tres bloques independientes entre sí; dentro
de cada bloque las fases van en orden de dependencias. Recomendado: **A primero** (es lo que más
nota el combate), luego B y C intercalados según dónde duela el rendimiento o la imagen.
Cada medición de coste con `perf_capture` (mediana de GPU, ver memoria de medición).

### Bloque A — Animación

#### Fase 23 — Inertialización (sustituye al crossfade)

Referencia: Bollo, _Inertialization: High-Performance Animation Transitions in Gears of War_
(GDC 2018). Hoy `AnimatorComponent` evalúa dos clips durante `blendTime` (`crossfadeFrom`).

- [ ] **23.1 Offset de transición**: al cambiar de estado, guardar por hueso la diferencia
      (rotación y traslación) entre la pose anterior y la nueva, y su velocidad (pose de los
      2 últimos frames). Solo se evalúa el clip nuevo.
- [ ] **23.2 Decaimiento** del offset con el polinomio quíntico (sin sobrepasar, velocidad y
      aceleración 0 al final); duración por transición (`blendTime` se reutiliza).
- [ ] **23.3 Modo por transición** `blend: 'inertial' | 'crossfade'` en los datos de la máquina
      de estados; por defecto inercial. Las capas (`addLayer`) también.
      _Hecho cuando:_ `anim_inertial`: idle → ataque → idle con la lanza; sin "flotar" (captura
      comparando ambos modos) y la evaluación cuesta como un solo clip.

#### Fase 24 — Clips aditivos y reacciones a golpes

- [ ] **24.1 Clip aditivo** = clip − pose de referencia (frame 0 o un clip base), calculado al
      cargar. `AnimLayerOptions.mode: 'override' | 'additive'` junto a `jointMask`.
- [ ] **24.2 Reacciones direccionales**: 4 clips (frente, espalda, izquierda, derecha) creados
      con `tools/anim`; se elige por la dirección del golpe (evento de daño de `CombatEventBus`)
      y el peso escala con el daño.
- [ ] **24.3** Sustituir `setAdditiveRotation` en sus usos (respiración, apuntar) por clips
      aditivos donde aplique.
      _Hecho cuando:_ `anim_hit_react`: golpes desde las 4 direcciones mientras el objetivo corre,
      ataca o está en idle, y la reacción se suma sin cortar la animación base.

#### Fase 25 — Blend spaces 1D/2D y grupos de sincronización

- [ ] **25.1 Blend space 1D** (velocidad: idle/andar/correr) y **2D** (dirección × velocidad,
      triangulación de las muestras y pesos baricéntricos) como tipo de estado de la máquina.
- [ ] **25.2 Grupos de sincronización**: fase normalizada compartida; el clip con más peso es
      el líder y los demás siguen su fase.
- [ ] **25.3 Marcadores de sincronía** (pie izquierdo/derecho en el suelo) exportados por
      `tools/anim` como eventos; sincronizar por marcador si los clips tienen distinto ritmo.
- [ ] **25.4** Parámetros float en el animator (`setFloat`), hoy solo hay bool y trigger.
      _Hecho cuando:_ `anim_locomotion`: el personaje acelera de 0 a correr y gira en curva sin
      deslizar los pies (Foot IK apagado para comprobarlo).

#### Fase 26 — Montajes: slots y secciones

- [ ] **26.1 Slots** (`FullBody`, `UpperBody`…) definidos como capas con máscara de huesos; un
      montaje se reproduce en un slot y mezcla con lo que haya debajo (inercial, fase 23).
- [ ] **26.2 Secciones** con nombre y enlace a la siguiente; saltar de sección desde código.
- [ ] **26.3 Ventanas de combo** (eventos de inicio/fin): una entrada dentro de la ventana
      encadena la siguiente sección; fuera, el montaje termina. Interrupción con prioridad.
- [ ] **26.4** Migrar el combo de lanza (4 clips de `tools/anim`) a un montaje de 4 secciones.
      _Hecho cuando:_ `anim_combo`: el combo de lanza se encadena entrando en la ventana, se corta
      fuera de ella y lo interrumpe una reacción a golpe.

#### Fase 27 — Motion warping y animaciones emparejadas

- [ ] **27.1 Ventanas de warping** en el clip (eventos): dentro de la ventana se escala la
      traslación y se corrige la rotación del root motion para terminar en un transform
      objetivo (posición del enemigo − distancia de golpe).
- [ ] **27.2 Animación emparejada**: dos animators en la misma línea de tiempo; la víctima se
      coloca respecto al atacante con el offset de referencia del clip, alineada con 27.1.
- [ ] **27.3 Datos** en `skills.json`: una habilidad puede pedir un par (atacante/víctima) y su
      toma en `ActionCameraComponent`.
      _Hecho cuando:_ `anim_paired`: ataque emparejado contra enemigos a 1, 2 y 3 m y en ángulos
      distintos; el golpe conecta en el mismo frame en todos los casos.

### Bloque B — Rendimiento y escala

#### Fase 30 — LOD automático

- [ ] **30.1 Generación offline** con `@gltf-transform` (`simplify`, usa meshoptimizer): 3 LODs
      por malla en un script tipo `compress-textures`, guardados en el `.glb`.
- [ ] **30.2 Selección en GPU** por tamaño en pantalla en `GPUCullingManager` (umbral
      configurable por malla); sombras con LOD sesgado hacia abajo.
- [ ] **30.3 Crossfade con dither** entre LODs (mismo patrón que `lodFadeStart` de la hierba),
      compatible con TSR.
- [ ] **30.4** Mallas con skin: LOD de huesos opcional (o solo simplificación de triángulos).
      _Hecho cuando:_ escena con 200 props: los triángulos dibujados bajan al alejarse (contador
      de debug) y no hay saltos visibles con TSR.

#### Fase 31 — Impostores y HLOD

Depende de la fase 30. HLOD solo merece la pena con niveles grandes; hacer primero impostores.

- [ ] **31.1 Impostores octaédricos**: bake offscreen (albedo, normal, profundidad) a un atlas
      por malla; se dibujan al G-Buffer como último LOD, con mezcla entre las 3 vistas más
      cercanas y profundidad por píxel.
- [ ] **31.2 HLOD**: agrupar estáticos por celda, fusionar y simplificar a una malla con atlas
      horneado; sustituye a la celda entera a partir de cierta distancia.
      _Hecho cuando:_ bosque de 2000 árboles: los lejanos son impostores sin que se note el
      cambio en una captura a 4K; draw calls y triángulos medidos.

### Bloque C — Trazado con el BVH (sigue `docs/realtime-gi-plan.md`)

#### Fase 28 — Resolución dinámica

- [ ] **28.1 Controlador**: tiempo de GPU del frame (`GPUProfiler`, mediana de N frames) contra un
      presupuesto (16,6 ms / 33,3 ms); un PI ajusta `renderScale` de TSR entre `min` y `max`.
- [ ] **28.2 Sin tirones al cambiar**: escalones cuantizados (5 %) con histéresis para no
      reasignar targets cada frame. Si aun así hay tirones, pasar a targets del tamaño máximo y
      dibujar en un viewport parcial (las UV de los pases de pantalla escalan).
- [ ] **28.3** Opción en `QualitySettings` y el menú (`off / 60 / 30`).
      _Hecho cuando:_ en `sponza_gi` con GI activa, el frame se mantiene en presupuesto y la escala
      se ve en el overlay del profiler; la escala vuelve a 1 cuando sobra GPU.

Scene change? Editor? Spawn prefabs?
Optimice everything

#### Fase 35 — Reflejos trazados como respaldo del SSR

- [ ] **35.1 Máscara de fallos** del SSR (confianza en la salida de `ssr.cs`).
- [ ] **35.2 Trazar** en el BVH solo los píxeles fallidos con rugosidad < umbral, a media
      resolución; sombrear el impacto con albedo/emisivo por triángulo + GI (sondas o
      radiance cache) + rayo de sombra al sol.
- [ ] **35.3** El compuesto de `ambient_specular.fs` usa SSR → trazado → cubemap, en ese orden.
- [ ] **35.4 (si hace falta)**: albedo con textura en el impacto (atlas de texturas para el BVH,
      no hay bindless).
      _Hecho cuando:_ suelo pulido en Sponza: lo que sale de pantalla se sigue reflejando (captura
      girando la cámara) y el coste medido está por debajo de 1 ms.

#### Fase 36 — Sombras y AO trazados

- [ ] **36.1 Sombras de luces de área**: un punto aleatorio en el rect/disco por píxel y frame +
      denoise temporal → penumbra real.
- [ ] **36.2 Sombras suaves del sol** más allá de la última cascada y como sustituto de las
      contact shadows (rayos cortos; también para puntos y focos).
- [ ] **36.3 AO trazado** (rayos cortos) como alternativa a GTAO.
- [ ] **36.4** Geometría con alpha test en el BVH (follaje) o excluirla con una marca.
      _Hecho cuando:_ luz de área con sombra que se ensancha con la distancia al oclusor;
      personajes (con 34.4) proyectan sombra de contacto en todas las luces.

---
