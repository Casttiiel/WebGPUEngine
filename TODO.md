# TODO — Roadmap de implementación del GDD

Todo lo necesario para llegar a lo que describe [GDD.md](GDD.md), ordenado por dependencias y
por riesgo de diseño: primero lo que decide si el juego es divertido. Cada tarea tiene un
**Hecho cuando** comprobable con un escenario del MCP (`public/data/scenarios/`), como en
[ROADMAP.md](ROADMAP.md). Los escenarios se llaman como su fase (`phase8_metal`,
`phase10_push`…).

**Punto de partida (ya hecho):** turnos con iniciativa `2·REF + 1d4`, Acción / Acción adicional /
Movimiento, catálogo de habilidades (`skills.json`: daño, curación, empuje, teletransporte,
superficie, estado), cooldowns, estado `fear`, caído y reanimación, props empujables,
lanzables y explosivos, superficies de fuego y aceite, bolsa de canicas para el crítico, IA
táctica con habilidades, cámara de acción, vista previa de daño, ficha de personaje y hotbar.
Fase 7: seis atributos y sus derivados, daño fijo con armadura → rango y crítico que la ignora.
Fase 8: Reserva de metal, coste en metal, Seco, recarga voluntaria y duraluminio (IA incluida).

**Lo que no existe y hará falta:** cobertura, reacciones, zonas genéricas, inventario/equipo,
progresión, diálogos.

---

## HITO 2 — ¿Es divertido? (los 4 personajes)

Orden: primero la base de la party; después cada personaje, que trae los sistemas que necesita
(siempre genéricos, como efectos de `skills.json`, porque los demás los reutilizan); las
asistencias al final, cuando ya existen todos los disparadores; y el patio con los cuatro.

### Fase 9 — Party: base común

- [x] **9.1 Sustituir Hero1–4** por los 4 personajes: prefabs (llamados como su clase), reparto
      inicial de atributos (GDD §3), autoataques (revólver, bastones, estoque o pistola ligera,
      escopeta).
- [x] **9.2 Duraciones fijas.** Quitar el bonus de turnos por POT (`statusBonusTurnsFor`, la
      fila "Estados aplicados" de la ficha y su texto en ActionText): cada estado dura lo que
      dice su habilidad (GDD §3).

### Fase 10 — Lanzamonedas (GDD §10.1) y lo que necesita

**Sistemas** (GDD §5 y §6):

- [x] **10.1 Datos de los props.** `metallic` y `size: small | large` en PropComponent, en
      lugar de `pushable`/`throwable`/`pushDistance`. Pequeños: cuchillos, clavos, monedas
      (munición del tirón y el empuje). Grandes: cajas, barriles, carros. Sin props fijos: lo
      que no se mueve es escenario estático. Migrar los props que ya existen y añadir alguno
      pequeño (cuchillos en una encimera).
- [x] **10.2 Metal portado** en las unidades (`metallic` en el prefab; más adelante saldrá del
      equipo) y la etiqueta `giant` (inmune a empuje y tirón).
- [x] **10.3 Efecto `steelPush`.** Línea recta alejándose del lanzador, `3 + POT/2` m; solo
      sobre lo metálico.
      _Hecho cuando:_ `phase10_push`: caja metálica empujada `3 + POT/2` m, caja de madera
      rechazada.
- [x] **10.4 Efecto `ironPull`**: hacia el lanzador; un enemigo con armadura metálica llega
      Derribado.
- [x] **10.5 Efecto `disarm`**: un arma metálica cambia el ataque del enemigo por uno débil.
- [x] **10.6 Regla de impacto.** Daño = base por tamaño (Pequeño 6 / Grande 10) + POT (con
      alomancia) o FUE (con peltre); Grande → Aturdido, Pequeño → solo daño, unidad
      empujada → Derribado; contra un muro +50 %; unidad contra unidad, las dos reciben daño.
- [x] **10.7 Salto generalizado.** `jumpArc` (hoy `MAX_JUMP` = 4,5) acepta una distancia
      máxima.
- [x] **10.8 Sin Lanzar.** Los personajes ya no lanzan objetos a mano (la acción `throw` sigue
      en el código, pero ningún personaje la tiene). Los objetos no tienen estados.
- [x] **10.9 Targeting `line`**: todos los de una línea recta, con su vista previa.
- [x] **10.10 Vista previa** de las trayectorias de empuje, tirón y rebote (AimArrow /
      PathPreview), con los objetivos afectados marcados.
- [x] **10.11 Estados físicos** (GDD §6): `stunned` (Aturdido: pierde la próxima Acción),
      `prone` (Derribado: levantarse cuesta la mitad del movimiento; el melee contra él es
      crítico seguro), `marked` (Marcado: el siguiente golpe que recibe hace +50 %, se consume).
      Iconos sobre la unidad y en el retrato, con tooltip. La IA aprovecha a los Derribados y
      Marcados.
      _Hecho cuando:_ `phase10_statuses` cubre cada uno con una aserción.

**Kit** (6 activas + duraluminio, GDD §10.0; cada una en `skills.json` con su `cost`, `metal` y
`allomantic: true` salvo la mente de hierro):

- [x] **Autoataque: revólver.** Ataque `ranged` de distancia larga (9.1).
- [x] **Salto de acero** — Adicional, 1 de metal. Salto de `6 + POT` m que no gasta movimiento
      (10.7).
      _Hecho cuando:_ con POT 4 salta 10 m, el movimiento no baja y la Reserva pierde 1.
- [x] **Empuje** — Acción, 2 de metal. `steelPush` (10.3): un prop o enemigo metálico en línea
      recta. Hay que estar al menos a 3 m y se puede desviar ±20° (primer click: el objetivo;
      segundo: hacia dónde).
- [x] **Tirón** — Adicional, 1 de metal. `ironPull` (10.4): atrae algo metálico; un enemigo con
      armadura metálica llega Derribado; si apunta a un arma metálica, `disarm` (10.5).
- [x] **Bala empujada** — Acción, 3 de metal. Targeting `line` (10.9): atraviesa a todos los
      enemigos de la línea, con +4 de penetración (campo `penetration` en el efecto de daño).
      _Hecho cuando:_ tres enemigos alineados reciben el daño y el cuarto, fuera de la línea, no.
- [x] **Marca del cazador** (estaño) — Adicional, 1 de metal. Marcado 2 turnos (10.11) con
      +30 % + 5 %·POT (decidido: escala con POT).
- [x] **Burbuja de acero** — Adicional, 2 de metal. Hasta su siguiente turno, los proyectiles
      (ataques a distancia y la Bala empujada) contra él tienen un 50 % de fallar (decidido).
- [x] **Mente de hierro** (feruquimia innata) — sin acción ni metal, 1 carga por combate que no
      se recarga (versión mínima; el sistema completo de mentes llega en la 18.3): Ligero (saltos
      ×2 este turno, combinable con el Salto de acero) o Pesado (no le pueden empujar, atraer ni
      derribar).

### Fase 11 — Deslizador (GDD §10.2)

- El recurso principal sigue siendo los metales.
- [ ] Mecanica de Ritmo (0–3, +15 % cada punto; se pierde al cambiar de objetivo, al recibir
      Aturdido o tras un turno sin golpear) y su indicador en el HUD (Pasiva, pero con icono con el % en el HUD).
- [ ] Lanzar: lanza al enemigo/prop grande en arco hasta 10 m → IMPACTO y Derribado (10.6).
- [ ] Avivar peltre: 2 turnos de +3 m de movimiento, inmunidad a Derribado y Aturdido y +20 % de
      daño; después, Arrastre (−50 % de movimiento y daño durante 1 turno).
- [ ] Deslizar: 4 m sin provocar reacciones; si acaba a la espalda, Marcado.
- [ ] Remate (peltre) — Acción, 1 de metal. Gasta todo el Ritmo en un golpe: daño del arma
      × (1 + 0,5 por punto de Ritmo); con 3 puntos, además deja Aturdido. Es el gastador del
      Ritmo: ¿sigo acumulando o lo suelto ahora?
- [ ] Mente de oro innata (sin acción, 1 carga por combate que no se recarga): decantar cura durante los proximos 3 turnos
      `10 + 3·RES`.(cuantos turnos crees que deban ser?)
- [ ] La **Burbuja de Bendaleo** es una zona: genera burbuja alrededor del personaje, personajes aliados y enemigos dentro hacen mas turnos por ronda (deberia incluir la misma ronda de casteo?) (deberian tener mas acciones/acciones adicionales? o directamente turnos seguidos antes de que les toque a los demas? Me entiendes?)

### Fase 12 — Cobertura (GDD §5): tapa o no tapa

- [ ] **12.1 Los props Grandes cortan la línea de visión.** Hoy `hasLineOfSight` solo mira la
      geometría estática: los props Grandes vivos también tapan; al romperse o moverse, dejan
      de tapar. Los Pequeños no.
- [ ] **12.2 Caras de cobertura.** Para un punto del suelo, qué coberturas tiene pegadas (a
      menos de ~1 m) y hacia dónde mira cada una: rayos horizontales a la altura del pecho en 8–16
      direcciones contra el escenario estático y los props Grandes → lista de normales de cara.
      Lo bajo (por debajo de ~1,2 m) no cuenta.
- [ ] **12.3 Regla.** Una unidad está a cubierto de un atacante si alguna de sus caras de
      cobertura lo tiene dentro de su arco (≈ 140°, configurable): entonces no hay línea de
      visión para ataques a distancia ni habilidades `unit` con `lineOfSight`. Si no, vale el
      rayo de siempre. No afecta al melee ni a las áreas.
      _Hecho cuando:_ `phase12_cover`: pegado a una columna, ningún enemigo del otro lado le
      puede apuntar (tampoco uno colocado casi en diagonal); el que flanquea sí; una bola de
      fuego le alcanza igual; al atraer el prop Grande tras el que se escondía, ya le pueden
      disparar.
- [ ] **12.4 Snap al moverse.** Si el destino elegido está cerca de una cobertura, se ajusta al
      punto pegado a ella (en combate y en exploración). En el destino, un escudo por cada
      dirección cubierta y qué enemigos dejarían de verle.
- [ ] **12.5 Vista previa al apuntar**: "a cubierto" (no se puede elegir) en lugar de la barra
      de daño.
- [ ] **12.6 Lo empujado en línea recta choca con la cobertura**, no con quien se esconde
      detrás (IMPACTO contra ella).
- [ ] **12.7 IA.** TacticalPlanner valora acabar a cubierto de las amenazas (usando el mismo
      snap), flanquear al que lo está y quitarle la cobertura (empujar o atraer el prop, áreas).

### Fase 13 — Voz (GDD §10.3)

- [ ] **Estados emocionales** (GDD §6): `enraged` (Enfurecido: objetivo forzado, que la IA
      tiene que respetar; +25 % de daño hecho, −3 de armadura) y `soothed` (Aplacado: sin
      Reacción y −25 % de daño). Decidir si `fear` se queda o se sustituye por Calma.
- [ ] Leer intenciones: muestra el TurnPlan que la IA tiene previsto para un enemigo.
      Requisito: que la IA planifique su turno **antes** y lo mantenga, o que se vuelva a
      planificar de forma determinista.
- [ ] Provocar: Enfurecido con un objetivo forzado que elige la Voz (puede ser ella misma).
- [ ] Arenga: un aliado gana +2 m de movimiento y +20 % de daño ese turno.
- [ ] Aplacar: en un enemigo, Aplacado y le quita los buffs; en un aliado, le quita los estados
      negativos.
- [ ] Calma: el enemigo no es hostil durante 1 turno; se rompe si recibe daño.
- La **Nube de cobre** es una zona: va en la fase 14.

### Fase 14 — Zonas genéricas (burbujas, nubes y lo que necesita la Artificiera)

- [ ] **14.1 Zonas genéricas**: círculo con duración y eventos al entrar, al salir, al empezar
      el turno dentro y al cruzar el borde un proyectil. Ampliar `Surfaces` o crear `Zones` con
      código compartido.
      _Hecho cuando:_ una zona de prueba aplica un estado al entrar y se deshace al caducar.
- [ ] **14.2 Bloqueo de proyectiles en el borde** de una zona (ataques a distancia y
      habilidades `unit` que cruzan el borde = desviados, sin daño). La vista previa lo enseña.
- [ ] **14.3 Burbuja de duelo** del Deslizador: +1 Acción por turno dentro, borde que bloquea
      proyectiles, se rompe si sale; el tamaño escala con POT.
- [ ] **14.4 Nube de cobre** de la Voz: inmunidad a los estados mentales y ocultación frente al
      bronce.

### Fase 15 — Artificiera (GDD §10.4)

- [ ] Gadgets sin cargas por combate: gastan metal de la Reserva y tienen recarga (cooldown),
      como el resto de habilidades.
- [ ] Munición cambiable (Acción adicional): normal / aluminio (atraviesa la Burbuja de acero) /
      dardo de cromo (aplica Seco; 2 de metal, recarga 3).
- [ ] Granada de cadmio (zona): movimiento ×0,5 y **se actúa al final de la ronda** (hace falta
      poder reordenar la iniciativa en caliente) y el borde bloquea proyectiles.
- [ ] Pulso de ettmetal: empuje radial de 4 m sobre todo lo metálico.
- [ ] Carga de ettmetal (Adicional, 1 de metal): etiqueta en un prop que lo hace explotar al
      recibir un IMPACTO. Nueva superficie de **agua** con la que el ettmetal reacciona.
- [ ] Inyector de oro: cura a un aliado adyacente `12 + POT`.
- **Liberar mente espiritual** va con las zonas espirituales (fase 17).

### Fase 16 — Reacciones y asistencias (GDD §7) ⚠️ el sistema más arriesgado

Con los cuatro personajes ya hechos, todos los disparadores existen y se prueban las
interacciones que se han diseñado, no unas de prueba.

- [ ] **16.1 Reacción** por unidad y por ronda (hoy los recursos solo existen para la unidad
      activa: hace falta un estado por unidad que se reponga al empezar su turno).
- [ ] **16.2 Bus de disparadores**: `impact`, `prone`, `crit`, `kill`, emitidos desde los
      puntos de resolución de EncounterComponent con origen, objetivo y quién causó la acción
      original.
- [ ] **16.3 Definición de asistencias en datos**: `assist: { trigger, skill }` en el prefab de
      cada personaje.
- [ ] **16.4 Las cuatro asistencias**: Tiro al plato (Lanzamonedas, DERRIBADO), Bateo
      (Deslizador, IMPACTO de un enemigo que acaba a su lado; redirección de 3 m), Encender el
      ánimo (Voz, BAJA o CRÍTICO de un aliado → ese aliado gana 1 Acción adicional; 1 de metal)
      y Detonación (Artificiera, IMPACTO → área de 2 m y Marcado; si el prop lleva ettmetal,
      explota).
- [ ] **16.5 Cola de resolución.** No se reacciona a las acciones propias, una por ronda, rango
      y línea de visión, las físicas se pueden hacer estando Seco, tope de 3 eslabones y bonus de
      cadena ×1,1/×1,2/×1,3.
      _Hecho cuando:_ `phase16_chain`: la cadena de ejemplo del GDD (§7) sale entera con los
      cuatro personajes y se para en el eslabón 3.
- [ ] **16.6 Guardia** del Deslizador: esquiva el primer melee y contraataca, gastando la
      Reacción (compite con Bateo); recuperación 2. Es la única reacción defensiva.
- [ ] **16.7 Previsualización de la cadena.** Simulación en seco al apuntar: retratos de los
      aliados que van a reaccionar; los eslabones que dependen de un crítico se marcan como
      "si hay crítico".
- [ ] **16.8 Interruptor por personaje**: automático / preguntar / nunca. En "preguntar", la
      cadena se pausa y sale un aviso.
- [ ] **16.9 Presentación**: cámara de acción en las cadenas, contador "Cadena ×2" y ActionText.
- [ ] **16.10 IA**: la IA intenta cortar las cadenas del jugador (Aplacar, matar al que remata).
      Las asistencias de los enemigos de élite van con ellos (fase 20).

### 🎯 Escenario de validación del Hito 2

- [ ] **Guardias del patio**: prefabs básicos de guardia con placas (metal portado, 10.2) y con
      aluminio (armadura alta sin metal: no se le puede empujar ni atraer). Su versión completa,
      con perfil de IA, va en la fase 20.
- [ ] **`phase16_patio`**: los 4 personajes contra un grupo de guardias (con placas y con
      aluminio) en un patio con cajas, columnas para cubrirse, cuchillos en una encimera, una
      farola y un charco (GDD §15).
      _Hecho cuando:_ se juega entero sin errores. **Decisión de seguir o no:** si el combate no es
      divertido, se revisan el metal, los empujes, la cobertura y las asistencias antes de
      seguir.

---

## HITO 3 — Zonas espirituales

### Fase 17 — Zonas espirituales (GDD §8)

- [ ] Fortuna: +2 canicas de crítico en la bolsa de quien ataca desde dentro.
- [ ] Conexión: un estado aplicado dentro se copia al resto de unidades del mismo bando que
      estén dentro.
- [ ] Investidura: las habilidades lanzadas desde dentro hacen +50 % de efecto (el `power` que
      ya usa el duraluminio).
- [ ] Afectan a **los dos bandos**; la IA lo tiene en cuenta (evita las zonas que le perjudican
      y aprovecha las que le benefician).
- [ ] Liberar mente espiritual (Artificiera): una zona activa a la vez, durante 3 turnos.
- [ ] Relicarios: props metálicos que emiten una zona; se mueven con empuje y tirón; al
      romperse, sueltan la zona de golpe durante 1 ronda.
      _Hecho cuando:_ `phase17_zones`: el Lanzamonedas atrae un relicario de Conexión y un
      Enfurecido se reparte entre 3 enemigos.

---

## HITO 4 — Capa RPG

### Fase 18 — Equipo y feruquimia (GDD §9)

- [ ] **18.1 Inventario y equipo** (no existe): ranuras de arma, armadura y 2 mentes de metal;
      UI en la ficha de personaje.
- [ ] **18.2 Armaduras**: cuero / placas (metal portado → se le puede empujar, atraer y desarmar)
      / aluminio (inmune al empuje). La armadura y la etiqueta `metallic` pasan a salir del equipo.
- [ ] **18.3 Sistema genérico de mentes de metal**: 1 carga por combate que no se recarga
      (en combate no se almacena); decantar no gasta acción. Las innatas (hierro del
      Lanzamonedas, oro del Deslizador) pasan a usarlo. Llenarlas es cosa de la exploración.
- [ ] **18.4 Las 11 mentes de la tabla del GDD**: oro, peltre, acero, hierro, estaño, cinc,
      bronce, electrum, cromo, latón y cobre.
- [ ] **18.5 Armas**: daño base, alcance, si son metálicas (pueden desarmarse) y penetración.

### Fase 19 — Progresión (GDD §14)

- [ ] XP y niveles; vida `+5` por nivel.
- [ ] 2 puntos de atributo por nivel con coste creciente (1 / 2 / 3) y su UI de reparto.
- [ ] **Sistema de talentos como modificadores** de las habilidades (parches sobre `SkillDef`:
      +duración, +objetivos, efecto extra).
- [ ] Árboles de 2 ramas por personaje (Aviador/Artillero, Virtuoso/Inmortal,
      Titiritero/Duelista, Ingeniera/Tiradora) con los talentos ya nombrados en el GDD: Rebote,
      Finta, Pullas, Arrollar, Peltre templado, Réplica…
- [ ] Hitos de nivel que dan acciones extra (segunda Reacción, segunda carga de duraluminio).

### Fase 20 — Enemigos (GDD §13)

Cada uno con su prefab, su perfil de IA y un escenario que demuestre su contrajuego:

- [ ] Guardia con placas (metal portado; el prefab básico ya existe desde el Hito 2)
- [ ] Guardia con aluminio (inmune al empuje)
- [ ] Koloss (Gigante, muy sensible a las emociones)
- [ ] Lanzamonedas enemigo (empuja y desarma a la party si lleva metal)
- [ ] Aplacador enemigo (quita Reacciones)
- [ ] Ahumador (nube de cobre: anula Leer intenciones)
- [ ] Inquisidor de Acero (élite con asistencias)
- [ ] Kandra (disfraz; se detecta con bronce o Agudeza)

---

## HITO 5 — Fuera del combate (GDD §12)

### Fase 21 — Exploración

- [ ] **21.1 Viales** como recurso de exploración (inventario, 18.1).
- [ ] **21.2 Pruebas deterministas**: dificultad visible; pasas si tu atributo llega o pagas
      1 vial por cada punto que falte; también se puede buscar otra solución.
- [ ] **21.3 Elementos interactuables**: cerraduras, trampas, puertas forzables, palancas
      lejanas, escombros.
- [ ] **21.4 Bruma con efecto en el juego**: límite de apuntado `6 + AGU` m dentro de la bruma
      froxel y sigilo de noche.
- [ ] **21.5 Una lente por personaje:**
  - [ ] Líneas azules: modo de visión que resalta el metal (trabajo de render: overlay o
        post-proceso).
  - [ ] Estaño: oír tras las paredes, oler la pólvora.
  - [ ] Deslizar para pasar patrullas o trampas.
  - [ ] Peltre para forzar puertas.
  - [ ] Bronce para detectar alomantes que se esconden; cobre para ocultar a la party.
  - [ ] Cerraduras y trampas mecánicas, fabricar viales y cargas.
  - [ ] Cobre feruquímico: diario de pistas.

### Fase 22 — Social (requiere un sistema de diálogo, que no existe)

- [ ] Sistema de diálogo con opciones condicionadas por personaje, atributo o coste.
- [ ] Aplacar y Encender en los diálogos (Voz), disfraces y acentos (Deslizador), intimidar
      (Lanzamonedas), conocimiento técnico (Artificiera).

---

## Decisiones pendientes que bloquean tareas

- [ ] ¿`fear` se queda como estado? (fase 13)
- [ ] Justificación narrativa de los personajes con varios metales (GDD §17)

---

<details>
<summary>Brief original del diseño (lo que dio origen al GDD)</summary>

A partir de ahora actua como un experimentado diseñador de videojuegos.
Como sabes quiero hacer mi juego como Baldurs Gate 3. Tematizado en los libros de nacidos de la bruma era 1 y 2.
Quiero tener una party de 4 personajes predefinidos. Cada personaje debe tener un playstyle o tener una "clase" que tendra un conjunto de habilidades de nacido de la bruma.
Quiero que me ayudes a diseñar qué 4 playstyles deberian/podrian tener. Y las habilidades/poderes de cada uno. Para ello usa como mecanicas los poderes de la alomancia, feruquimia y artilugios que salen en los libros.

Mecanicas ya pensadas:
Cada personaje tiene una barra de "mana" que realmente sera la cantidad de metales que tienen. Usar una habilidad, gasta de esa barra. Cuando te quedas sin, el proximo turno tu personaje no puede usar magias ya que ha bebido un vial y esta recargando los metales.
Posibilidad de lanzar o empujar cajas pesadas o props que hayan por el escenario para aturdir/hacer daño a los enemigos.
Combos/Asistencias: con algunas acciones concretas otros personajes pueden reaccionar a la accion que haya realizado un personaje y propinar un golpe extra o algo asi. Por ejemplo: Con un personaje lanzo una caja a un enemigo, al golpearlo, otro personaje de la party dispara tambien al enemigo para hacer daño extra. Me diseñas en qué momentos esto ocurriria? Y cuales serian las reacciones de los demas?
Pensaba añadir tambien alguna manera de crear zonas/campos infusos de Fortuna (para mas probabilidad de critico), Conexion (si haces un bufo o debufo en el area, se comparte entre todos los personajes), Investidura (potencia las magias), pero no se como se formarian si como item,habilidad o prop del environment. Y si es ya muchas mecanicas juntas.

En mi juego no hay % de acierto, aciertas siempre. Si hay % de critico.
Los personajes hacen un daño "fijo", en base a sus stats. Pero ese daño puede convertirse en un rango de daño en base a la armadura del que recibe el golpe. Por ejemplo: mi personaje hace 10 de daño, pero como el enemigo tiene 5 de armadura, mi ataque pasa a hacer entre 7 a 10 de daño. Ayudame a diseñar una formula para eso.
Los personajes tienen stats, pero no quiero usar los tipicos de DnD hasta cierto punto, quiero hacerlos de manera que tengan sentido en mi juego.
Aqui te dejo un listado de estadisticas que creo que vale la pena que los atributos modifiquen: % Crit, Daño Magico, Daño fisico, Daño de asistencia/combo, Numero de acciones por turno, Vida, Armadura, Iniciativa. Ayudame a diseñar los atributos y dime si faltan estadisticas que añadirias.

Ahora te voy a describir poderes/habilidades/aplicaciones de los poderes/magias de mistborn que se me han ocurrido que pueden trasladarse al juego.
Autoataque: Puños/espada/pistola
Steel Push/pull: Salto grande para moverse grandes distancias. Atraer /empujar objetos para lanzar los props del escenario como dije.
Peltre: Modo berserker durante x turnos donde te mueves mas rapido y pegas mas. Durante los proximos X turnos te curas X puntos de vida. Lanzar props pero esta vez escogiendo el angulo.
Estaño: Marca del cazador para que el siguiente ataque quite mas vida. Durante X turnos posibilidad de esquivar ataques melee. Contraataque instintivo.
Cinc, encender emociones: Buff a aliados, taunts o efectos negativos al enemigo.
Laton, aplacar emociones: Quitar debuffs de aliados y efectos positivos a enemigos.
Cadmio/Bendaleo: Burbuja de tiempo para pegarte a otra velocidad con el enemigo concreto.
Duralominio: Habilidad que tienen todos los de la party, al usarlo la siguiente habilidad es el doble de fuerte, pero te agota todo el mana.
Steel push/pull: burbuja para % de esquivar balas. Mega disparo. Disparo encadenado. Disparo con rebote. Desarme
Cromo: Silencio de habilidades
Bronce: Revela proxima accion del enemigo
Cubo de ettmetal: Para lanzarlo y crear burbujas de cadmio/bendaleo o steel para empujar o otros. Tendria X cargas por combate.
Oro feruquimio: Reserva de salud / curacion pasiva. Una vez por combate.
Peltre feruquimico: Mega ataque una vez por comate.
Electrum feruquimico: Mega velocidad una vez por combate.

Nose si quizas los poderes feruquimios podrian ser objetos que equipas. Para dar personalizacion o que habilidades/pasivas puedan dar los objetos equipables.

Arquetipos/clases/estilos de juego que ya he pensado:
Ranged/Rogue a distancia: Personaje que ataca a distancia con gran movilidad ya que puede hacer los saltos grandes del steel. Por balancear no lo se, pero quizas tambien es el que peude lanzar los props y cajas del environment?
Berserker/bardo: Se bufa con peltre y cinc para pegar durante unos turnos y luego usa laton y cinc para evitar que le focuseen. (no me convence del todo)
Personaje que usa en parte gadgets, como el ettmetal cube, y puede infundir de algunos metales el cubo.

Tampoco he pensado en nada de stats o posibles acciones fuera del combate, como abrir cerraduras o deteccion de trampas o lo que sea, me ayudas a diseñar tambien algunos de eso?

</details>
