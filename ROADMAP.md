# Roadmap — Prototipo táctico estilo Baldur's Gate 3

Tareas pendientes, por orden de importancia. Cada una tiene un criterio **"Hecho cuando"** comprobable (escenario del MCP o captura).

Reparto de ataques confirmado: **Hero1 y Hero4 cuerpo a cuerpo**, **Hero2 y Hero3 a distancia**.

---

## 1. Arreglar los escenarios de test
Los escenarios de las fases 2 a 5 no se han vuelto a pasar tras los últimos cambios y varios fallarán por:
- El reparto melee / distancia: Hero1 ya no dispara (`phase3_combat`, `phase5_environment`).
- Los críticos: el daño ya no es fijo y hay asserts de PV exactos.
- La espera del golpe a la cámara de acción: las esperas fijas en frames tras atacar.
- El seguimiento de la party: los seguidores andan y pueden ser detectados antes.
- El acercamiento automático: donde antes había "sin visión" / "fuera de alcance" ahora se acerca, y cambió el orden de los motivos de rechazo.
- Los puntos del recorrido solo en combate (`PathDot` en `phase3_combat`, `phase3_turns`, `phase5_skills`).
- El arco del salto (alturas distintas) y el bloque de oclusores eliminado de `phase5_environment`.
- **Hecho cuando:** `run_scenario *` pasa entero.

## 2. La IA usa habilidades y test del acercamiento automático
- La IA enemiga elige y lanza habilidades (área, curación, empujón, miedo…) con las mismas reglas que el jugador (`planSkill` / `requestSkill`).
- Comprobar cómo se comporta la IA ahora que los ataques a distancia, empujar, saltar y las habilidades se acercan solos.
- **Hecho cuando:** un escenario de IA enseña a un enemigo lanzando una habilidad útil y otro cubre el acercamiento automático en sus turnos.

## 3. Vista previa del daño en la barra de vida del objetivo y rango de daño
- Los ataques y habiliades que hacen daño ahora no hacen daño exacto sino unn rango. Como hacen los juegos para calcular el valor concreto? Deberiamos hacerlo igual. Como afecta esto a la vista previa del daño en la barra de vida?
- Al apuntar un ataque o una habilidad, la barra de vida del objetivo marca la parte que perdería (y si muere).
- **Hecho cuando:** al pasar el ratón por un enemigo con un ataque armado se ve el tramo de vida que quitaría.

## 4. Tooltips en la hotbar
- Al pasar el ratón por un ataque o una habilidad: nombre, coste, recarga, alcance y descripción (los mismos textos que la ficha del personaje).
- **Hecho cuando:** cada hueco de la hotbar enseña su tooltip.

## 5. Ayuda de controles en pantalla
- Un panel discreto con los controles (mover, cámara, C, Tab, Q/E, Espacio, R…), que se pueda mostrar u ocultar.
- **Hecho cuando:** la ayuda se ve en pantalla y se oculta con una tecla.

## 6. Silueta solo con el escenario
- Que un personaje detrás de otro personaje no salga en silueta: solo cuando lo tapa el escenario (muros, columnas…).
- **Hecho cuando:** dos personajes que se tapan entre sí no se marcan, y uno detrás de una columna sí.

## 7. Ficha del personaje con vista aislada
- El modelo de la izquierda en una vista propia (fondo neutro, iluminación propia), sin el escenario ni otros personajes, como en BG3. Requiere un segundo render del personaje.
- **Hecho cuando:** al abrir la ficha solo se ve al personaje seleccionado.

## 8. Empujar y lanzar objetos estilo Marvel's Midnight Suns
- Empujar o lanzar objetos con una trayectoria clara: en línea recta o en arco, con la vista previa de por dónde irá, a quién golpea y dónde acaba.
- Golpear a las unidades que pilla en el camino (daño por impacto).
- **Hecho cuando:** se apunta un objeto, se ve su trayectoria (recta o en arco) y al lanzarlo golpea a lo que hay en medio.
