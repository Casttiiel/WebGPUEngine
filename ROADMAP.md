# Roadmap — Sistema de IA de combate

**Ya implementado:** Behavior Trees · NavMesh / pathfinding · KCC con Rapier

El orden de implementación no es capa por capa — es por impacto y dependencias.  
El token system va primero aunque sea Capa 3: sin él el resto del sistema no tiene sentido.

---

## Bloque 1 — Token System
*Capa 3 · Director — el más crítico, implementar antes que todo lo demás*

El token system es la columna vertebral de todo el combate. Controla quién ataca y cuándo. Sin él, todos los enemigos atacan simultáneamente y el combate es injusto desde el primer encuentro.

**CombatDirectorComponent**  
Componente en la entidad de escena. Gestiona un pool de N tokens (`maxActiveAttackers: 2` por defecto). API pública:
- `acquireToken(enemy) → bool` — el enemigo pide permiso para atacar
- `releaseToken(enemy)` — devuelve el token al terminar el ataque
- Expiración automática: si el poseedor no ataca en X segundos, el token se libera solo  

Sin token = el enemigo orbita al jugador pero **no ataca**.

---

## Bloque 2 — Percepción
*Capa 1 · IA individual*

Sin percepción el enemigo es omnisciente. Se siente barato y elimina cualquier posibilidad de sigilo o de "escapar" de un encuentro.

**Sight cone — FOV + raycast**  
Ángulo de visión configurable + distancia máxima. Raycast desde los ojos del enemigo al jugador — si impacta un obstáculo antes de llegar, no ve al jugador. Update a 10 Hz (no cada frame).

**Hearing radius — radio de sonido por evento**  
El jugador emite `NoiseEvent(position, radius, type)` al correr, atacar, aterrizar, abrir puertas. Cada enemigo comprueba si el evento ocurrió dentro de su radio de escucha. Sin raycast, solo distancia. El tipo de evento determina el nivel de alerta resultante (caminar → susurro, atacar → alerta total).

**Memory — última posición conocida del jugador**  
Cuando el enemigo pierde visión, almacena `lastKnownPos` y navega a ese punto antes de volver a IDLE. Nodos nuevos en el BT: `IsPlayerVisible`, `GoToLastKnownPos`, `ClearMemory` al llegar sin encontrar al jugador. Crea tensión — el jugador que escapa no está seguro todavía.

---

## Bloque 3 — Combat movement
*Capa 1 · IA individual*

Es lo más ignorado y lo que más diferencia hace en game feel. Un enemigo que se mueve bien parece inteligente aunque tome decisiones simples.

**Circle strafing**  
Mientras espera token, el enemigo orbita al jugador a su distancia de combate preferida. Samplea posiciones en arco sobre el NavMesh y navega a la más cercana que esté libre. Elimina los enemigos estáticos mirando al jugador en fila.

**Step back al recibir daño**  
Al recibir un hit: impulso KCC en dirección opuesta a la fuente de daño + estado stagger de 0.3s (sin atacar, sin moverse, libera token si lo tiene). El combate se vuelve bidireccional — el jugador tiene agencia sobre la posición del enemigo.

**Positioning intent — buscar flanco y distancia óptima**  
Si hay aliados en el mismo ángulo, detectar saturación de sector y buscar el arco opuesto. Usa los sectores del encirclement (Bloque 5) como input. Hace que los enemigos busquen ángulos sin necesidad de scripting explícito.

---

## Bloque 4 — Toma de decisiones
*Capa 1 · IA individual*

**Attack selection — qué ataque usar y cuándo**  
Cada tipo de ataque tiene: `minRange`, `maxRange`, `baseWeight`, `cooldown` individual (no cooldown global). Al entrar en fase de ataque: filtrar por rango actual, aplicar pesos, seleccionar con random ponderado. Los cooldowns son por tipo de ataque — permite variedad sin parecer caótico.

**Cooldown management — timing entre ataques**  
Cooldowns independientes por tipo de ataque. El enemigo siempre puede atacar con *algo* si está en rango — solo los ataques costosos tienen cooldown largo.

**Condiciones contextuales — modificadores de peso**  
- Jugador en el aire → sweep bajo gana peso
- Jugador agachado → overhead gana peso  
- Jugador de espaldas → ataque rápido de bajo coste gana peso  

Se implementa como tabla de modificadores en el data asset del enemigo. Fácil de tunear por diseño sin tocar código.

**Threat assessment — evalúa distancia, HP, contexto del grupo**  
Factor que combina: distancia al jugador, HP propio, número de aliados en combate, tokens disponibles. Alimenta las decisiones de huir vs perseguir y el nivel de agresividad individual.

**Reaction to player — dodge, guard, counter**  
- Parry del jugador → stagger prolongado (0.8s), libera token automáticamente, ventana de contraataque visible
- Jugador en el aire más de 0.3s → preparar ataque al nivel del suelo para castigar el aterrizaje
- Jugador huyendo → perseguir activamente o llamar refuerzos vía broadcast

---

## Bloque 5 — Coordinación de grupo
*Capa 2 — todo por implementar*

Aquí está la diferencia entre un hack and slash mediocre y uno bueno. Sin coordinación los enemigos son islas que no interactúan entre sí.

**Broadcast de eventos — ally attacking, alerted...**  
Bus de eventos compartido por `CombatGroup`. Eventos clave: `AllyAttacking`, `AllyDead`, `PlayerSpotted`, `PlayerRetreat`. Cada enemigo escucha y ajusta su BT en consecuencia. Sin esto, que muera un aliado no afecta a nadie.

**Steering con separation**  
Fuerza de repulsión entre enemigos dentro de radio de separación (~1.5m). Se aplica como offset al destino del NavMesh agent — no como fuerza física directa, para no luchar contra Rapier. Elimina el pile-up visual que delata IA barata.

**Formación dinámica — encirclement y surround**  
Dividir el círculo alrededor del jugador en N sectores (uno por enemigo activo). Cada enemigo reclama el sector válido más cercano a su posición. Navegar hacia el centroide del sector reclamado. Sin scripting — el encirclement emerge de la asignación de sectores. Si un sector queda libre (aliado muerto), otro enemigo lo reclama.

---

## Bloque 6 — Director completo
*Capa 3 — todo por implementar*

**Role assignment — Aggressor, Flanker, Support, Harasser**  
El Director asigna un rol al inicio del encuentro y lo reasigna si el contexto cambia (aliado muerto, token liberado, distancia drástica):
- `Aggressor` — tiene token activo, ataca ahora
- `Flanker` — sin token, busca ángulo lateral o trasero
- `Harasser` — ataques rápidos de bajo daño desde distancia, mantiene presión sin arriesgar
- `Support` — si un aliado está en stagger prolongado, distrae al jugador para que el aliado se reposicione

**Pressure escalation — agresividad dinámica**  
El Director trackea `timeSincePlayerDamaged`. Umbrales de escalada:
- +8s sin recibir daño → `maxActiveAttackers` sube en 1, cooldown entre rondas baja 20%
- +15s → Harassers pasan a Aggressors, los enemigos empiezan a hacer fakes/feints más frecuentes
- HP del jugador < 30% → todos los Harassers se convierten en Aggressors  

Se resetea cuando el jugador recibe daño. Previene el stalemate donde el jugador circlestrafea sin consecuencias. Hace que quedarse quieto sea peligroso.

---

## Orden de implementación resumido

| Bloque | Contenido                           | Capa | Impacto  |
| ------ | ----------------------------------- | ---- | -------- |
| 1      | Token system                        | 3    | Crítico  |
| 2      | Percepción (sight, hearing, memory) | 1    | Alto     |
| 3      | Combat movement (strafe, step back) | 1    | Alto     |
| 4      | Toma de decisiones y reacciones     | 1    | Alto     |
| 5      | Coordinación de grupo               | 2    | Medio    |
| 6      | Roles + pressure escalation         | 3    | Medio    |

> 🏁 **Milestone final:** combate tácticamente coherente con hasta 6 enemigos simultáneos sin sentirse injusto
