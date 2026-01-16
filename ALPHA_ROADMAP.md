# A) Core Feel (lo primero o todo lo demás da igual)

- **Arreglar el salto para que no se sienta pesado**

  - Gravedad distinta subida/bajada
  - Apex hang time
  - Control aéreo por fase
  - ✅ Objetivo: el salto ya es “divertido” solo.

- **Definir y cerrar el feel del Dash a Anclas**

  - Target selection estable (dot product, no “primer hit”)
  - Feedback visual de target (highlight + crosshair pegado)
  - Feedback si no hay target (crosshair apagado)
  - ✅ Objetivo: nunca “dash no responde”.

- **Dar JUICE básico a las 3 acciones clave**
  - Dash: trail + sonido fuerte + micro FOV kick
  - Wallrun: sonido continuo + partículas
  - Walljump: impacto + whoosh + shake suave
  - ✅ Objetivo: que el movimiento sea adictivo.

# 🧠 B) Consistencia y “Predictable Results”

- **Implementar “grace windows” (Player Grace)**

  - Wallrun grace (ej. 150ms antes de soltar pared)
  - Dash grace (ej. 100ms si target casi válido)
  - No cambiar objetivo por microaim jitter
  - ✅ Objetivo: se siente profesional, no janky.

- **Cerrar el sistema de Wallrun re-entry (anti infinito)**
  - Lockout en misma pared tras 2.5s
  - Reentrada solo con:
    - suelo
    - walljump
    - dash
    - distancia mínima
    - pared distinta
  - ✅ Objetivo: no exploits, no loops.

# 🧩 C) Simplificación (quitar ruido para iterar bien)

- **Congelar temporalmente mecánicas no esenciales**

  - (No borrarlas, solo no iterarlas aún)
  - Swing Bar (post-MVP)
  - Roll Jump (post-MVP)
  - Anclas Fásicas (post-MVP)
  - ✅ Objetivo: que 3 mecánicas queden perfectas en vez de 10 “ok”.

- **Elegir oficialmente 2 ecos (no 3)**
  - Cinético
  - Inercia
  - ✅ Objetivo: meta simple, rutas claras, balanceable.

# 🧪 D) Balance real (para speedrun y nivel design)

- **Replantear el castigo de “fallar un salto”**

  - Preferir castigo “de ruta” (caer a camino inferior)
  - Si mantienes castigo numérico:
    - que sea solo con Eco de Inercia (modo riesgo)
  - ✅ Objetivo: castigo legible, no frustrante.

- **Construir un “MVP Level 1” de 45–60s SOLO para iterar**

  - Debe enseñar:
    - salto
    - dash a anclas
    - wallrun/walljump
  - ✅ Objetivo: iterar a cuchillo el core loop.

- **Medallas/objetivos para speedrun (desde ya)**
  - Bronze/Silver/Gold
  - y 1 “Dev Time” (ultra pro)
  - ✅ Objetivo: easy but deep real.
