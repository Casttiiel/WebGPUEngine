# 1. MOVIMIENTO BÁSICO

## 1.1 Run

- **Velocidad correr (objetivo activo):** 9 m/s
- **Velocidad máxima sin ecos:** 14 m/s
- **Aceleración:** 0 → 9 en ~0.25 s
- **Fricción en suelo:** baja
- **Regla de “momentum”:**
  - correr te lleva a 9
  - si vas por encima, el juego no te frena artificialmente
  - solo pierdes velocidad si dejas input o chocas
- **Objetivo:** el movimiento se siente fluido y recuperable, no rígido.

## 1.2 Salto

- **Altura salto base:** 2.2 m
- **Tiempo en aire objetivo:** ~0.75 s (orientativo, no ley sagrada)
- **Coyote time:** 120 ms
- **Jump buffer:** 100 ms
- **Control aéreo base:** 65%
- 💡 _El salto se tuneará por game feel, no solo por física perfecta._

# 2. ACCIONES DE TRAVERSAL

## 2.1 Wallrun

- **Duración máxima:** 2.5 s
- **Velocidad mínima para entrar:** ≥ 7 m/s
- **Entrada:** conserva ~85% velocidad horizontal
- **Desgaste:** −5% / s
- **Gravedad durante wallrun:** reducida (tuneable)
- El wallrun continúa sin input (input solo modula)
- **Anti-loop wallrun (reentrada):**
  - No puedes reiniciar wallrun en la misma pared tras agotarlo por tiempo.
- **Se desbloquea wallrun de nuevo con alguna acción válida de reset:**
  - ✅ tocar suelo
  - ✅ wall jump
  - ✅ dash a objeto
  - ✅ separarte de la pared (distancia mínima)
  - ✅ cambiar de pared (normal distinta)

## 2.2 Wall Jump

- **Dirección:** diagonal (fuera de pared + un poco de momentum)
- **Velocidad vertical:** igual que salto base (o levemente menos si se abusa)
- **Conserva ~85% de velocidad horizontal previa**
- **Input “lock” suave:** control aéreo reducido durante 0.12 s
- NO se desactiva input completamente

## 2.3 Mantling

- Acción de recuperación / fluidez (no de optimización)
- Permite escalar bordes sin frenar el ritmo
- No debe romper el speedrun (mantle = ruta segura, no la más rápida)

## 2.4 Dash a objetos

- Dash aéreo dirigido a targets del mundo (Anclas de Eco / Núcleos de Rebote)
- **Distancia típica:** 8 m (dependiendo de colocación de target)
- **Duración:** 0.25 s
- **Conserva 80% de velocidad previa (horizontal)**
- **Base:** 1 dash por salto
- **Recarga:** solo al tocar suelo
- ✅ Objetivo: herramienta de corrección + rutas avanzadas por diseño del nivel.

## 2.5 Impulse Pads

- Fuerza externa del nivel
- Sirven para:
  - velocidad
  - verticalidad
  - setups de ruta
- No deben sentirse como “teleport”; deben integrarse con momentum

## 2.6 Swing Bar

- Movimiento pendular controlado
- Sale con velocidad conservada
- Debe ser:
  - espectacular (juice)
  - consistente (sin random)
- Sirve como “generador” de velocidad (ver sección 6)

# 3. SKILL TECH (profundidad “easy but deep”)

## 3.1 Impulse Step (ÚNICA mecánica “perfect” del juego)

- Esta es tu tech central de skill, como el dash de Bloodthief.
- **Input:** Soltar correr justo antes de aterrizar
- **Ventana:** 120 ms
- **Efecto:**
  - Conservas 100% velocidad horizontal
  - Conviertes parte de la energía vertical en horizontal (bonus de salida)
- **Bonus recomendado (simple y legible):**
  - Si vienes cayendo (velocidad vertical negativa):
    - ganas +8% a +15% velocidad horizontal (cap en 14)
    - según lo “limpio” del timing (gradual)
- ✅ Esto hace que Impulse Step:
  - no sea “castigo por no hacerlo”
  - sea premio real por hacerlo
- 📌 _Regla clave (filosofía Bloodthief):_
  - Si NO haces Impulse Step → no pasa nada malo.
  - Simplemente no obtienes el bonus.

## 3.2 “Salida perfecta” (ya NO es “perfect system”)

- Se mantiene como concepto, pero como gracia / suavidad, no como combo.
- **Nueva versión:**
  - Jump dentro de ±80 ms al tocar suelo:
    - se siente más “snappy”
    - permite conservar mejor control
    - puede dar un microfeedback (sonido/click)
  - NO acumula stacks
  - NO da buffs
  - NO recarga dash por sí sola (solo con eco cinético, ver abajo)
- ✅ Así cumple:
  - “player grace”
  - sin convertirse en minijuego de ritmo obligatorio

## 3.3 Roll Jump (pendiente)

- Se queda como tech avanzada opcional.
- No se balancea todavía hasta que:
  - jump, dash, wallrun estén perfectos.

# 4. WORLD OBJECTS (diseño de niveles)

## 4.1 🔵 Anclas de Eco (Dash Targets)

- **Qué son:** Orbes fijos flotantes
- **Siempre visibles**
- **Claramente “dashables”**
- **Qué hacen:** Permiten dash a objetos
- **Son la “infraestructura” del nivel**
- **Para quién:**
  - Casual: corregir saltos, rutas seguras
  - Speedrunner: rutas aéreas, atajos

## 4.2 🟠 Núcleos de Rebote (Rebound Targets)

- ✅ Rebote pasa a ser OBJETO PRINCIPAL, no eco.
- **Qué son:** Orbes más pequeños o móviles (en aire o encima de enemigos)
- **Qué hacen:** Dash → rebote (impulso vertical + conservación de horizontal)
- **Rebote base:**
  - +5 m vertical
  - conserva 80% horizontal
- **Para qué sirven:**
  - Verticalidad
  - Skips
  - Rutas sin suelo
  - Expresión de skill (timing/ángulos)

## 4.3 🟢 Carriles de Inercia (Speed Lanes)

- **Qué son:** Suelo especial tipo “pista”
- **Señal clara de velocidad**
- **Qué hacen:**
  - +20% aceleración
  - No frena al aterrizar (mantiene momentum)
- **Uso:**
  - setups para saltos largos
  - llegada a 12–14 m/s de forma legible

## 4.4 🟣 Anclas Fásicas (Ruta premium, opcional)

- **Qué son:** Targets avanzados, visualmente distintos
- **Regla:** Solo se activan si vas a >12 m/s
- **Diseño:**
  - Invisible para casual (no lo necesita)
  - Ruta premium para expertos (WR tech)
- ✅ Esto es muy bueno porque crea “skill gates” sin castigos.

# 5. ECOS (2 ecos completos, sin solapes)

## 🟦 Eco 1 — CINÉTICO (Dash chaining / rutas aéreas)

- **Fantasía:** “Puedo mantener movilidad sin tocar suelo si juego limpio.”
- **Modifica:**
  - Dash recarga en el aire, pero solo con acciones claras:
    - ✅ Wallrun ≥ 0.8 s → +1 dash
    - ✅ Salida perfecta (jump en ±80 ms tras aterrizar) → +1 dash
- **Limitador:** Cooldown recarga: 0.35 s
- **Qué incentiva:**
  - Encadenar anclas
  - Rutas aéreas largas
  - Wallrun como “repostaje”
  - Flow sin tocar suelo
- **Qué NO hace:**
  - No aumenta rebotes
  - No escala salto
  - No da velocidad base gratis (esto es clave para que no se coma a Inercia)

## 🟩 Eco 2 — INERCIA (Velocidad / racing line)

- **Fantasía:** “Si voy rápido, pierdo menos velocidad y salto más lejos.”
- **Modifica:**
  - Wallrun conserva 100% en entrada (sin corte del 15%)
  - Desgaste wallrun reducido: −5%/s → −2%/s
  - Dash conserva más velocidad: 80% → 90%
  - Jump scaling por velocidad:
    - base 2.2 m
    - bonus +0.05 m por m/s sobre 8
    - máx ~3.0 m (cap razonable)
- **Qué incentiva:**
  - Racing line
  - Mantener 12–14 m/s
  - Minimizar errores y choques
  - “runs limpias” para WR
- **Castigo (modo riesgo):**
  - Solo si quieres una capa de riesgo:
    - Si chocas fuerte a >10 m/s → speed \*0.75
    - (No por fallar saltos, solo por impacto claro)

# 6. “CÓMO SE LLEGA A 14 m/s” (fuentes explícitas)

- **14 m/s NO se consigue “corriendo”.**
- Se consigue por generadores del nivel + skill.
- **Fuentes reales de velocidad:**
  - ✅ Carriles de inercia (+20% aceleración)
  - ✅ Impulse pads (boost directo)
  - ✅ Swing exit (conserva velocidad alta)
  - ✅ Caídas + Impulse Step (conversión vertical → horizontal)
  - ✅ Rutas largas sin fricción + trazada limpia
- **Esto hace que 14 sea:**
  - legible
  - merecido
  - diseñable

# 7. FAIL / GRACE RULES (sin castigos injustos)

## 7.1 “Fallar un salto” — definición FINAL (se queda)

- ✅ Fallar un salto es SOLO si:
  - no aterrizas en superficie válida
  - usas dash de emergencia para no caer
  - chocas con geometría no jugable
  - caes al vacío

## 7.2 Castigo al fallar (cambio importante)

- ❌ NO hay “−30% velocidad instantánea” global.
- ✅ Castigo es de ruta/tiempo, no de stats:
  - caes a una ruta inferior
  - pierdes segundos
  - mantienes control y consistencia
- 📌 Si quieres castigo numérico:
  - solo con Eco de Inercia (modo riesgo)
  - y solo en impactos duros

## 7.3 Grace Rules recomendadas (para eliminar jank)

- Wallrun grace: 150 ms antes de soltarte por perder pared
- Dash grace: 100 ms para targets justo en rango
- Objetivo estable: no cambiar target por micro aim jitter
