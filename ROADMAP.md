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

### 1. Valores por defecto afinados por tipo de enemigo

> Melee básico: cooldown 4-6 s | Berserker: 2-3 s | Tanque: 7-10 s | Arquero: 3-5 s

Cambiar `individualCooldownMs` y `attackPaceMs` por tipo. Cero arquitectura nueva.

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

### 13. "1 atacante + 1 preparándose" como estado explícito

> _"A golpeando, B acercándose, C D E F rodeando"_

El director puede conceder dos tokens distintos: `ATTACK` y `PREPARE`.
El token `PREPARE` permite al enemigo acercarse al jugador (rango corto) pero no atacar todavía.
Cuando el `ATTACK` termina, el `PREPARE` se convierte automáticamente en el nuevo `ATTACK`.
Crea flujo continuo: siempre hay alguien que llega justo cuando el anterior termina.

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
