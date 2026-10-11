# Roadmap — Prototipo táctico estilo Baldur's Gate 3

Objetivo: el **esqueleto jugable** de un RPG táctico por turnos con party de 4. Sin stats, clases, inventario ni diálogos: solo el bucle *explorar → entrar en combate → turnos → victoria/derrota*.

Cada hito tiene un criterio **"Hecho cuando"** verificable (idealmente vía MCP, ver Fase 0).

Piezas del motor que se reutilizan: ECS + prefabs, `src/ai/nav` (NavMesh + A*), `src/ai` (Behavior Trees, Blackboard), Rapier (raycasts/colisiones), `HealthComponent`, `AbilitySystem`, `DummyEnemyController`, `src/core/ui`, `gamestates.json`.

---

## Fase 0 — MCP del motor (para que Claude pueda iterar solo) ✅

Va primero porque acelera todo lo demás: sin esto, cada cambio necesita que tú mires la pantalla y me cuentes qué pasa.

> **Estado: implementada.** Documentación y formato de escenarios en [tools/mcp/README.md](tools/mcp/README.md).
> - Usa Edge del sistema vía Playwright, porque no hay Chrome instalado.
> - `get_combat_state` y `game_command` ya están cableados, pero devuelven "no provider" hasta que la Fase 3 llame a `DevBridge.registerCombatProvider(...)`.
> - Los overlays de rangos se registran con `DevBridge.registerOverlay(...)`.

**Principio:** el motor **no es un editor en tiempo real**. La fuente de verdad son los ficheros (código TS, `boot.json`, prefabs, `components.json`) y se editan en VS Code. El juego en ejecución solo se usa para **observar y verificar**. Por tanto el MCP no edita el mundo en vivo: arranca el juego, lo mira, lo controla y comprueba resultados. Cualquier cambio se hace en ficheros y se valida recargando.

Ciclo de trabajo: *editar ficheros → `run_checks` → `launch`/`reload` → observar (logs, screenshot, estado) → controlar (input/comandos) → verificar (asserts) → repetir*.

**Arquitectura:** servidor MCP en Node (`tools/mcp/`, stdio, registrado en `.mcp.json`) que:
- arranca/reutiliza el dev server de Vite,
- abre Edge/Chrome con WebGPU mediante **Playwright** (ventana visible por defecto; headless si los drivers lo permiten),
- habla con el juego con `page.evaluate()` contra una API de debug `window.__engine` que solo existe en `dev`.

No hace falta bridge WebSocket: Playwright da consola, errores, screenshots, input real y evaluación de JS de serie.

### 0.1 Ciclo de vida y observación (imprescindible)
- **`launch` / `close`** — arrancar Vite + navegador, esperar a que la escena esté cargada (señal `__engine.ready`). Opcional: escena/escenario inicial por query param.
- **`reload`** — recargar tras editar ficheros y esperar a `ready`. Si Vite falla al compilar, devolver el error en lugar de quedarse colgado.
- **`get_logs`** — consola (log/warn/error), excepciones no capturadas y errores de validación WebGPU, con stack traces; filtrable desde la última recarga.
- **`screenshot`** — captura del canvas (opcional: tras N frames, con o sin overlay de debug).
- **`get_status`** — FPS, escena cargada, game state actual, nº de entidades.
- **`run_checks`** — `type-check` + `lint` con errores estructurados (fichero, línea, mensaje). No necesita el juego abierto.

### 0.2 Validación de datos (sin ejecutar)
- **`list_components`** — componentes registrados y sus campos/tipos (desde código + `components.json`), para escribir prefabs correctos a la primera.
- **`list_prefabs`** — prefabs disponibles y qué componentes usan.
- **`validate_data`** — comprobar `boot.json`, prefabs y JSONs de skills/encuentros contra esos esquemas: campos desconocidos, tipos erróneos, referencias a prefabs/assets inexistentes.

### 0.3 Inspección del juego en ejecución (solo lectura)
- **`list_entities`** — entidades con nombre, id, componentes y posición (filtrable).
- **`get_entity`** — volcado JSON de los componentes de una entidad.
- **`eval`** — ejecutar una expresión JS en la página para preguntas puntuales (escape hatch de depuración, no para modificar contenido).

### 0.4 Control: tiempo, input y determinismo
- **`pause` / `resume` / `step(frames)`** — avance determinista frame a frame.
- **`set_time_scale`** — acelerar (p.ej. dejar que la IA juegue 10 turnos rápido).
- **`simulate_input`** — click en posición de mundo (proyectada a pantalla) o de pantalla, teclas, rueda, arrastre. Input real de Playwright, así se prueba la misma ruta que usa el jugador.
- **Semilla del RNG** — por query param al lanzar, para tiradas reproducibles.

### 0.5 Herramientas específicas del juego táctico
- **`get_combat_state`** — orden de turnos, personaje activo, acciones y movimiento restantes, vida y estado de todos.
- **`game_command`** — acciones de alto nivel como las haría el jugador: `move(unit, pos)`, `attack(unit, target)`, `use_skill(unit, skill, target)`, `end_turn()`. Es la misma API que usa la IA enemiga.
- **`query_path` / `query_los`** — camino en el navmesh (puntos, coste, alcanzable) y línea de visión entre dos puntos/entidades.
- **`debug_draw`** — activar overlays (navmesh, caminos, rangos, LOS, colliders) antes de un screenshot.
- **`run_scenario`** — lanzar el juego con un **escenario en fichero** (`public/data/scenarios/*.json`: posiciones de party y enemigos, semilla), ejecutar una secuencia de comandos y evaluar asserts (`unit X hp == 0`, `state == Victory`…). Los escenarios se versionan en git y sirven como tests de regresión del gameplay.

**Hecho cuando:** puedo editar un fichero, recargar, mover un personaje, hacer un screenshot y leer los errores sin que tengas que intervenir.

---

## Fase 1 — Escenario y cámara ✅

> **Estado: implementada.** Test: `run_scenario phase1_camera`.
> - **Escena:** `assets/scenes/tactical.json`, cargada desde `boot.json` en ~1 s. Los prefabs están en `prefabs/tactical/`.
> - **Navmesh:** se genera a partir de los colliders estáticos con el componente `scene_navmesh`.
> - **Cámara:** `TacticalCameraRig [tactical_camera_controller]` mueve su hija `PlayerCamera [camera]`, con el mismo patrón que `camera_arm` y `fps_camera_controller`. Seguir una unidad es una referencia que se activa y desactiva (F / Home / pan).
> - **`unit`:** componente marcador de bando (party / enemigo / neutral), que será la base de la Fase 2.
> - La unidad activa de la cámara la fija la party al seleccionar (Fase 2).

### 1. Escenario simple
- Escena de prueba: suelo plano, unas paredes, cajas/columnas como obstáculos, algún desnivel (rampa/plataforma) para más adelante.
- Iluminación sencilla (sol + ambient). Nada de streaming ni assets pesados.
- **Hecho cuando:** carga desde `boot.json` en < 2 s y el navmesh se genera correctamente sobre ella.

### 2. Cámara táctica
- Cámara orbital con *pivot* en el suelo (no atada al personaje), vista isométrica-ish con pitch fijo/limitado.
- Modo "seguir" al personaje activo con transición suave al cambiar de turno.
- **Hecho cuando:** la cámara enfoca a cualquier unidad con un lerp suave y nunca atraviesa el suelo.

### 3. Controles de cámara
- Pan: WASD / bordes de pantalla / arrastre con botón central.
- Rotación: Q/E o arrastre con botón central + modificador.
- Zoom: rueda, con límites y ajuste suave del pitch al hacer zoom (más cenital al alejar).
- Tecla para recentrar en el personaje activo (Home / doble click en retrato).
- **Hecho cuando:** se puede recorrer todo el mapa cómodamente sin perder la orientación.

---

## Fase 2 — Party y exploración ✅

> **Estado: implementada.** Test: `run_scenario phase2_party`.
> - **`party`** (entidad `Party` de la escena): miembros, seleccionado, teclas 1-4 y Tab / Shift+Tab. La cámara sigue siempre al personaje seleccionado.
> - **`tactical_pointer`:** picking desde el ratón, resaltado del personaje bajo el cursor, anillos de hover (azul aliado, rojo enemigo) y cursor contextual: seleccionar / atacar / mover / no válido. "Mover" solo aparece si el seleccionado puede llegar andando. Click en un aliado lo selecciona.
> - **Anillos:** decals creados en runtime (`GroundMarker`) para que `InstanceManager` no los agrupe.
> - **HUD:** retratos en `assets/ui/party_hud.json` + `PartyHUDController` (nombre, tecla, seleccionado y hover; click selecciona). Sustituye al HUD FPS.
> - **Motor:** se ha implementado el render de texto bitmap (`TextWidget` / `UIRenderUtils.renderText`), que estaba sin hacer. Ya no se pierden los clicks de UI más cortos que un frame.

### 4. Party (4 personajes)
- `PartyComponent` / `PartyManager`: lista de 4 miembros, miembro seleccionado.
- Selección por click en el personaje, por retrato o con teclas 1-4.
- Indicador visual de selección (anillo/decal bajo los pies).
- **Hecho cuando:** puedo seleccionar cada miembro y la cámara/UI responden.

### 5. Selección y cursor contextual *(añadido)*
- Raycast desde el ratón contra suelo y entidades: hover con highlight/outline.
- El cursor cambia según lo que hay debajo: mover / atacar / no válido.
- **Hecho cuando:** pasar el ratón sobre un enemigo, un aliado o el suelo da feedback distinto.

---

## Fase 3 — Núcleo del combate por turnos

> **Puntos 7-10 implementados.** Test: `run_scenario phase3_turns`.
> - **7. Estados:** componente `encounter` (entidad `Encounter`): exploración → combate → victoria / derrota. No usa `gamestates.json`: allí los gamestates son conjuntos de módulos y cambiar de uno a otro reinicia boot, cámara, etc. Un enemigo que ve a la party (rango + línea de visión) inicia el combate; entran los enemigos a menos de `joinRadius` de la party.
> - **Fin de combate:** de momento, por comando (`game_command end_combat`). Las condiciones "enemigos muertos" y "party caída" se conectan con el ataque (punto 12). Los enemigos de un combate terminado no vuelven a detectar.
> - **8. Turnos:** iniciativa d20 con el RNG del juego (`?seed`), rondas, recursos por turno (1 acción, 1 adicional, 9 m), fin de turno con Espacio o con el botón, fin automático sin recursos, y enemigos que se unen tarde colocados por iniciativa. Hasta que exista la IA, los enemigos pasan turno.
> - **9. Movimiento:** click en el suelo. En combate, limitado a los metros que quedan; si el destino está más lejos, avanza por el mismo camino hasta donde llegue. Vista previa con puntos en el suelo (rojos lo que excede) y metros junto al cursor. La UI, el MCP y la IA usan las mismas reglas (`planMove` / `requestMove`).
> - **10. Obstáculos:** el navmesh de la escena es un TileCache de Detour y cada unidad es un cilindro (radio de la cápsula + radio del agente), salvo la que actúa. Los caminos rodean unidades y nunca terminan dentro de otra.
> - **Exploración:** click mueve solo al seleccionado. La party no sigue en formación (el punto 6 se quitó).

### 7. Máquina de estados de juego *(añadido)*
- Estados: `Exploration` ↔ `Combat` (+ `Victory` / `Defeat`), integrada con `gamestates.json`.
- Entrada a combate: un enemigo detecta a la party (radio/LOS) o el jugador ataca primero.
- Salida: todos los enemigos muertos → volver a exploración; toda la party caída → derrota.
- **Hecho cuando:** acercarse a un enemigo inicia el combate y matarlo lo termina.

### 8. Turnos
- Orden de iniciativa (tirada d20 simple con RNG sembrado, sin stats).
- Rondas: cuando todos han actuado, nueva ronda.
- Economía de acciones por turno — el esqueleto de BG3 sin números: **1 Acción, 1 Acción adicional, X metros de movimiento**. Se resetean al empezar el turno.
- Fin de turno manual (botón / Espacio) y automático si no quedan recursos.
- Los participantes que entran tarde se insertan en el orden.
- **Hecho cuando:** el combate rota correctamente entre party y enemigos durante varias rondas.

### 9. Movimiento en combate
- Movimiento limitado por los metros restantes del turno.
- **Preview de camino** al hacer hover: línea del recorrido, coste en metros, color distinto si excede el alcance.
- Visualización del área alcanzable (opcional: anillo de alcance aproximado).
- **Hecho cuando:** no se puede mover más allá del presupuesto y el preview coincide con el camino real.

### 10. Movimiento con obstáculos
- Navmesh con obstáculos estáticos (ya existe) + **unidades como obstáculos** (no atravesar aliados/enemigos; cortar el navmesh o penalizar en A*).
- Re-cálculo si el destino queda bloqueado. Destino inválido → cursor de "no válido".
- **Hecho cuando:** los caminos rodean cajas y unidades y nunca terminan dentro de otra.

### 11. Enemigo dummy
- Prefab de enemigo con vida, que entra en la iniciativa y simplemente pasa turno.
- **Hecho cuando:** un combate 4 vs 2 dummies funciona de principio a fin.

### 12. Ataque
- Ataque cuerpo a cuerpo (requiere estar adyacente; si no, ofrecer "moverse y atacar") y a distancia (requiere LOS y rango).
- Resolución esqueleto: tirada de impacto fija 100% + daño fijo. Sin stats, pero con el punto de enganche para meterlas después.
- **Hecho cuando:** atacar consume la Acción, acertar y resta vida.


### 13. Línea de visión y cobertura *(añadido)*
- Raycast (Rapier) para LOS entre atacante y objetivo.
- Ataques a distancia bloqueados si no hay visión.
- **Hecho cuando:** esconderse detrás de una columna impide ser atacado a distancia.

### 14. Muerte, derrota y victoria *(añadido)*
- Vida a 0: enemigo muere (sale de la iniciativa); aliado queda "caído" (sale o salta turno).
- Condiciones de fin de combate y transición de estado (ver 7).
- **Hecho cuando:** ambos finales (victoria/derrota) se alcanzan y se puede reiniciar.

### 15. UI
- **Barra de iniciativa** (arriba): retratos en orden, el activo resaltado, hover → resalta la unidad en el mundo.
- **Retratos de party** (izquierda) con barra de vida; click para seleccionar.
- **Hotbar** (abajo): ataque, skills, fin de turno; teclas numéricas; estado deshabilitado si no hay recurso.
- **Indicadores de recursos**: Acción / Acción adicional / movimiento restante.
- **Tooltips** de skills y del objetivo (vida, % impacto).
- **Texto flotante** de daño/fallo/curación sobre las unidades.
- Banner de "Turno de X" / "Victoria" / "Derrota".
- **Hecho cuando:** se puede jugar un combate entero sin overlays de debug.

---

## Fase 4 — IA enemiga ✅

> **Estado: implementada.** Test: `run_scenario phase4_ai`.
> - **`tactical_ai`:** Behavior Tree por unidad (`src/ai` + nodo nuevo `Wait`): pensar → planificar → moverse → atacar → pasar, con pausas para que se entienda. Usa `requestMove` / `requestAttack`, las mismas reglas que el jugador y el MCP.
> - **`TacticalPlanner`:** puntúa atacar desde aquí, acercarse y golpear, moverse para disparar (alcance + línea de visión, guardando distancia), retirarse y esconderse con poca vida, o avanzar hacia el más cercano.
> - **Enemigos:** Bruto (cuerpo a cuerpo, mucha vida), Arquero (a distancia, se retira) y Hostigador (rápido, se une a mitad de combate), en `tactical_enemies.json`. Los dummies de la Fase 3 siguen en `tactical_dummies.json` para sus tests.
> - **Nunca se atasca:** un vigilante corta cualquier turno de la IA que pase de 20 s (`aiTimeouts` en `get_combat_state`).

### 16. Enemy AI
- Behavior Tree (reutilizando `src/ai`) que decide **en el turno** usando las mismas `game_command` que el jugador.
- Scoring simple de acciones: para cada objetivo candidato → ¿alcanzable este turno? ¿% de impacto? ¿daño esperado? Elegir la mejor.
- Comportamientos base: melee (acercarse y pegar), ranged (buscar posición con LOS y distancia), retirarse si está bajo de vida.
- Pausas/ritmo para que el jugador entienda lo que hace la IA (la cámara la sigue).
- **Hecho cuando:** un combate contra 3 enemigos variados es un reto mínimamente creíble y no se atasca nunca.

## Fase 5 — Habilidades

### 17. Improvements ✅
- **Saltar**: acción que salta obstáculos/huecos consumiendo movimiento.
- **Muros que tapan la cámara**: hacer transparentes o recortar los muros entre la cámara y el pivot, como en BG3. Hoy se evita limitando el pivot (`bounds`) al interior del mapa.
- **Interacción con el entorno**: objetos empujables/explosivos (barriles), superficies (fuego/charco) que aplican efectos al entrar. Gasta la **acción adicional**.
- **Hecho cuando:** se salta un muro bajo, un barril empujado o disparado cambia el combate y ningún muro tapa a las unidades.

> **Estado: implementado.** Test: `run_scenario phase5_environment`.
> - **Saltar** (hotbar): hasta 4.5 m, gasta los metros saltados. Pasa por encima de cajas y muros bajos, sube a la plataforma; columnas y muros altos no. Vista previa con los metros.
> - **Empujar** (hotbar, o click en un objeto): gasta la acción adicional (en exploración es gratis). Hay que estar al lado; el objeto se desliza hasta 3 m y se para contra paredes, unidades o desniveles.
> - **Objetos** (`tactical_prop`): son unidades neutrales con vida, así que se apuntan, bloquean caminos y se atacan con las mismas reglas. El barril explosivo hace 12 de daño en 2.5 m, deja fuego y explota en cadena. Atacar un objeto requiere armar un ataque en la hotbar; el click normal empuja.
> - **Superficies** (`tactical_surface`): el fuego quema 5 al entrar y al empezar el turno dentro, y dura 3 rondas. El aceite prende con el fuego o una explosión. Las de la escena vuelven al reiniciar.
> - **Oclusores** (`camera_occluder` en muros y columnas): cuando tapan a una unidad o al pivote de la cámara cambian a un material con tramado semitransparente. No se instancian.
> - **Escena:** los objetos están en `tactical_props.json` (dos barriles, aceite y una caja), que `boot.json` carga y los tests de las fases 2-4 no.
> - **Motor:** al destruir un `particle_system` en runtime, el render seguía usando sus buffers y la pantalla se quedaba en negro. Ahora se da de baja al destruirse.

### 18. Skills ✅
- Modelo de datos genérico (JSON/prefab): coste (Acción / Acción adicional), rango, tipo de targeting, efecto.
- Tipos de targeting: **unidad**, **punto en el suelo**, **área (círculo/cono)**, **self**.
- Efectos esqueleto: daño, curación, empujón (aprovecha `PushAbility`), teletransporte.
- Preview del área y de quién queda afectado antes de confirmar.
- Cooldowns por turno (en lugar de spell slots).
- **Hecho cuando:** hay 3–4 skills distintas funcionando (bola de fuego en área, curación, empujón, dash).

> **Estado: implementado.** Test: `run_scenario phase5_skills`.
> - **Datos:** catálogo en `public/data/skills.json`. Cada habilidad define coste (`action` / `bonusAction`), `cooldown` en turnos, targeting (`unit` / `point` / `cone` / `self`), alcance, radio o cono, a quién afecta y una lista de efectos (`damage`, `heal`, `push`, `teleport`, `surface`). Las unidades las referencian por id (`unit.skills`).
> - **Seis habilidades:** Bola de fuego (punto + área, daña a todos y deja fuego), Onda atronadora (cono, daño + empujón), Palabra curativa (aliado; levanta a un caído), Segundo aliento (self), Empellón (enemigo adyacente, empujón) y Embestida (punto, en línea recta sin gastar movimiento).
> - **Héroes:** Hero1 Empellón + Segundo aliento, Hero2 Bola de fuego + Onda atronadora, Hero3 Palabra curativa + Embestida, Hero4 Embestida + Empellón (en `tactical.json`).
> - **UI:** van en la hotbar tras los ataques, con su coste y los turnos de recarga. Al armar una se ve el contorno del área (o la línea de la embestida), se resaltan los afectados (los aliados se marcan) y una etiqueta resume el efecto o por qué no se puede. Las de self se lanzan al pulsarlas.
> - **Reglas:** `planSkill` / `requestSkill`, igual que ataques, saltos y empujones (MCP: `skill`, `plan_skill`). Fuera de combate no gastan recursos ni tienen cooldown. Una habilidad hostil contra un enemigo empieza el combate. Los cooldowns avanzan al empezar el turno del lanzador y se reinician al acabar el combate.
> - **Empujón:** usa las reglas de empuje del punto 17 (`pushDistance`), no `PushAbility`, que es un esbozo vacío del modo FPS (impulso físico).
> - **Pendiente:** la IA enemiga aún no usa habilidades.

### 19. Reacciones *(añadido)*
- Ataque de oportunidad al salir del alcance cuerpo a cuerpo de un enemigo.
- Es lo que hace que el posicionamiento importe; con una sola reacción ya se nota.
- **Hecho cuando:** alejarse de un enemigo adyacente dispara su ataque.

---

## Fase 6 — Pulido del esqueleto (si sobra tiempo)

- **Feedback**: cámara que encuadra al atacante y objetivo, hit-stop, partículas de impacto (ya existen piezas).
- **Animaciones básicas**: idle, andar, atacar, recibir golpe, morir (usar el sistema de animación existente).
- **Guardar/cargar** el estado de la party y el combate.
- **Ventaja por altura**: bonus de impacto desde arriba; daño por caída al ser empujado.
- **Encuentros definidos en datos**: un JSON por encuentro (enemigos, posiciones, trigger).

---

## Fuera de alcance (a propósito)

Estadísticas, clases, niveles, inventario, equipamiento, diálogos, misiones, multijugador, generación de contenido.

---

## Orden sugerido

1. **0.1 + 0.2 + 0.3** del MCP (ciclo de vida, validación de datos, inspección).
2. Escenario → cámara → controles.
3. Party + selección + movimiento en exploración.
4. **0.4 + 0.5** del MCP (control, comandos de juego y escenarios de test).
5. Estados de juego → turnos → movimiento en combate → obstáculos → dummy → ataque → LOS → fin de combate.
6. Skills → reacciones → UI.
7. IA enemiga.
8. Pulido.

Hito jugable mínimo (*vertical slice*): **fin del paso 5** — 4 personajes vs 2 dummies, por turnos, con movimiento y ataque. A partir de ahí todo es añadir capas.
