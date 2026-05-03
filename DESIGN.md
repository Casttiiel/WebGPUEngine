# LAS GARRAS

Son el verbo central absoluto. Todo el diseño gira alrededor de ellas. Se agarran a bordes, salientes y anillas.

Tienen tres comportamientos según el punto de agarre:

- **Borde con superficie encima** — el personaje viaja hasta el punto donde puede hacer mantling
- **Esquina** — dobla y cambia de dirección conservando momentum
- **Anilla o viga sin superficie encima** — impulso puro, no aterrizas, sigues volando

El momentum es clave. Las garras no te teletransportan — te lanzan. Encadenar garras acumula velocidad, momentum based.

Usos secundarios (futuro): atraer plataformas/objetos, romper obstáculos frágiles.

Economía de cargas: empiezas con 3, se amplía a 5 con progresión. Recarga automática por tiempo.

---

## Grapple System — Tasks

### TASK 1: Charge Economy

**Goal:** El jugador tiene un número limitado de usos que se recarga automáticamente por tiempo.

- [x] Añadir `chargeCount`, `maxCharges`, `rechargeTime` a `GrappleSystemData`
- [x] Inicializar con 3 cargas (expandible a 5 vía progresión)
- [x] Descontar una carga en `startGrapple()`, retornar `false` si no hay cargas disponibles
- [x] Acumular un timer; devolver una carga cuando el timer llega a 0
- [x] Exponer `getCharges()` y `getMaxCharges()` para HUD/debug
- [x] Añadir `setMaxCharges(n)` para que el sistema de progresión lo invoque

---

### TASK 2: Target Type Detection

**Goal:** El raycast determina el tipo de punto de agarre, que define el comportamiento del grapple.

- [x] Definir enum `GrappleTargetType { LEDGE, CORNER, RING }`
- [x] En `tryActivateFarReach()`, analizar el hit para clasificar el target:
  - **LEDGE**: normal.y > umbral — hay suelo encima donde hacer mantle
  - **CORNER**: normal.y ≈ 0 — arista/cara vertical lateral con dirección de salida distinta
  - **RING**: el collider hit tiene componente `GrappleHookComponent` — anilla/viga sin superficie encima
- [x] Pasar el `GrappleTargetType` a `startGrapple()` y almacenarlo en el estado interno

---

### TASK 3: Snap-Assisted Targeting + HUD

**Goal:** El grapple solo funciona en puntos válidos (LEDGE, CORNER, RING). El sistema detecta el mejor target cada frame y hace snap. El jugador ve el target y sus cargas.

#### 3a — Snap targeting

- [x] Mover la detección de target a `updateGrappleTarget()`, llamado cada frame en IDLE
- [x] Lanzar N rayos en cono alrededor del centro de cámara (cuadrícula 3×3 con ~3° spread)
- [x] Clasificar cada hit (LEDGE/CORNER/RING); descartar hits sin tipo válido
- [x] Escanear también entidades con `GrappleHookComponent` dentro del rango (para RINGs que estén detrás de otros colliders)
- [x] Entre los candidatos válidos, elegir el de menor ángulo al rayo central
- [x] Almacenar `pendingTarget: { point, visualPoint, type } | null` en el controller
- [x] En `tryActivateFarReach()`, usar `pendingTarget` en vez de hacer un raycast fresco

#### 3b — Indicador visual de target

- [x] Añadir widget `grapple_target_indicator` (ImageWidget, anchor: none, pivot centrado) a `hud.json`
- [x] En `HUDController`, proyectar `visualPoint` a NDC con `camera.getViewProjection()`, luego a espacio de referencia 1920×1080
- [x] Mover el widget al punto proyectado y mostrarlo solo cuando hay `pendingTarget` válido
- [x] Colorear según tipo: LEDGE = blanco, CORNER = cyan, RING = dorado

#### 3c — HUD de cargas

- [x] Añadir widgets de carga a `hud.json`: un contenedor + N slots (alias `grapple_charge_fill_0` … `grapple_charge_fill_4`)
- [x] En `HUDController`, lazy-resolve `ArcaneKnightControllerComponent` del jugador
- [x] Cada frame: mostrar solo los `maxCharges` slots activos; colorear llenos (blanco) vs vacíos (gris oscuro)
- [x] Animar el slot en recarga usando `grappleSystem.getRechargeProgress(i)` para hacer fill progresivo

---

### TASK 4: Target Markers / Visual Feedback

**Goal:** El jugador ve sobre qué puede hacer grapple y de qué tipo es.

- [x] Al hacer el raycast, guardar hit point y tipo en el controller
- [x] Colorear el color del puntero que ya existe en la UI según el tipo: LEDGE / CORNER / RING

---

### TASK 5: Behavior LEDGE — Viaje a punto de mantle

**Goal:** Al agarrarse a un borde con superficie encima, el personaje viaja hasta el punto de mantle y lo ejecuta automáticamente.

- [x] Calcular el `movementTarget` como el top of ledge real (no el impacto lateral)
- [x] Al llegar (`ARRIVED`), si el target type es `LEDGE`, llamar a `setIsMantling(true)` en vez de volver a IDLE
- [x] Pasar la dirección de mantle al `MantleSystem` para que arranque correctamente

---

### TASK 6: Behavior CORNER — Redirección conservando momentum

**Goal:** Al agarrarse a una esquina, el personaje dobla la esquina manteniendo la velocidad acumulada.

- [ ] Al finalizar el grapple con tipo `CORNER`, calcular la nueva dirección de salida (reflejar la velocidad alrededor de la normal del hit)
- [ ] Conservar el módulo de velocidad (`vec3.length(flyVelocity)`) y aplicarlo en la nueva dirección
- [ ] Asegurar que `currentHorizontalVelocity` y `currentVerticalVelocity` reflejan el momentum resultante al volver a IDLE

---

### TASK 7: Behavior RING — Impulso puro

**Goal:** Al agarrarse a una anilla o viga, el jugador recibe un impulso puro y sigue volando sin aterrizar.

- [ ] Al arribar con tipo `RING`, transferir `flyVelocity` como velocidad de salida en vez de zerear
- [ ] En el controller, al salir del estado GRAPPLING con tipo RING, copiar la velocidad a `currentHorizontalVelocity` + `currentVerticalVelocity`
- [ ] El estado IDLE recibe ese momentum y lo disipa gradualmente via `MovementSystem`

---

### TASK 8: Momentum Chaining

**Goal:** Encadenar garras acumula velocidad — el speed bonus de una grapple se lleva a la siguiente.

- [ ] Trackear `chainVelocityBonus: number` en el controller (se resetea al tocar el suelo)
- [ ] Al terminar una grapple, sumar la velocidad de llegada al `chainVelocityBonus`
- [ ] En `startGrapple()`, incorporar el `chainVelocityBonus` al speed del lanzamiento
- [ ] Resetear `chainVelocityBonus` cuando `isGrounded === true`

---

### TASK 9: Progresión — Unlock de cargas extra

**Goal:** El sistema de progresión puede expandir las cargas de 3 a 5.

- [ ] Exponer `grappleSystem.setMaxCharges(n)` desde el controller/módulo de progresión

---

### TASK 10 (Futuro): Atraer objetos y romper obstáculos

**Goal:** Usos secundarios de las garras sobre entidades del entorno.

- [ ] **Attract:** Si el target tiene `AttractableComponent`, mover el objeto hacia el jugador (lanzamiento invertido) en vez de mover al jugador
- [ ] **Break:** Si el target tiene `FragileComponent`, destruir el objeto al activar el grapple sin mover al jugador
- [ ] Ambos consumen una carga igualmente
