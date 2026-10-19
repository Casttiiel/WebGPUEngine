# TODO — Roadmap de implementación del GDD

Todo lo necesario para llegar a lo que describe [GDD.md](GDD.md), ordenado por dependencias y
por riesgo de diseño: primero lo que decide si el juego es divertido. Cada tarea tiene un
**Hecho cuando** comprobable con un escenario del MCP (`public/data/scenarios/`), como en
[ROADMAP.md](ROADMAP.md). Las fases siguen la numeración de los escenarios que ya existen
(`phase1…phase6`).

**Punto de partida (ya hecho):** turnos con iniciativa d20, Acción / Acción adicional /
Movimiento, catálogo de habilidades (`skills.json`: daño, curación, empuje, teletransporte,
superficie, estado), cooldowns, estado `fear`, caído y reanimación, props empujables,
lanzables y explosivos, superficies de fuego y aceite, bolsa de canicas para el crítico, IA
táctica con habilidades, cámara de acción, vista previa de daño, ficha de personaje y hotbar.

**Lo que no existe y hará falta:** atributos, armadura, recurso de metal, reacciones, zonas
genéricas, inventario/equipo, progresión, diálogos.

---

## HITO 2 — ¿Es divertido? (prototipo con 2 personajes)

### Fase 12b — Lanzamonedas (GDD §10.1)

- [ ] Salto de acero en su hotbar.
- [ ] Empuje y Tirón (con Desarme) como habilidades con coste en metal.
- [ ] Bala empujada: atraviesa a todos los de la línea y tiene +4 de penetración.
- [ ] Marca del cazador → Marcado.
- [ ] Burbuja de acero: Reacción; desvía los proyectiles contra él y contra aliados a 3 m hasta
      su siguiente turno.
- [ ] Mente de hierro innata: Ligero (saltos ×2) / Pesado (inmune a empuje, tirón y derribo).
- [ ] Duraluminio: Meteoro, y empuje que arranca un prop Fijo.
- [ ] Asistencia: Tiro al plato (Lanzado o Desequilibrado; +50 % contra Lanzado).

### Fase 12c — Deslizador (GDD §10.2)

- [ ] Recurso Ritmo (0–3, +15 % cada punto; se pierde al cambiar de objetivo, al recibir
      Aturdido o tras un turno sin golpear) y su indicador en el HUD.
- [ ] Proyección: lanza al enemigo en arco hasta 4 m → IMPACTO y Derribado.
- [ ] Avivar peltre: 2 turnos de +2 m de movimiento, inmunidad a Derribado y Aturdido y +20 % de
      daño; después, Arrastre (−50 % de movimiento y daño durante 1 turno).
- [ ] Guardia: esquiva el primer melee y contraataca, gastando la Reacción; recuperación 2.
- [ ] Deslizar: 4 m sin provocar reacciones; si acaba a la espalda, Desequilibrado.
- [ ] Burbuja de duelo (zona 12.2): +1 Acción por turno dentro, borde que bloquea proyectiles,
      se rompe si sale; tamaño y duración escalan con POT.
- [ ] Mente de oro innata: almacenar (−20 % de vida → 1 carga, máximo 3), decantar
      (`10 + 3·RES` por carga), decantar como Reacción por debajo del 25 %.
- [ ] Duraluminio: Mil golpes (requiere estar en la burbuja).
- [ ] Asistencia: Bateo (Derribado o llega empujado a su lado → golpe y redirección de 3 m).

### Fase 12a — Party: base común

- [ ] **12.1 Sustituir Hero1–4** por los 4 personajes: prefabs, nombres provisionales, reparto
      inicial de atributos (GDD §3), autoataques (revólver, bastones, estoque o pistola ligera,
      escopeta).
- [ ] **12.2 Zonas genéricas** (requisito de las burbujas, la nube de cobre y las zonas
      espirituales): círculo con duración y eventos al entrar, al salir, al empezar el turno dentro
      y al cruzar el borde un proyectil. Ampliar `Surfaces` o crear `Zones` con código compartido.
      _Hecho cuando:_ una zona de prueba aplica un estado al entrar y se deshace al caducar.
- [ ] **12.3 Bloqueo de proyectiles en el borde** de una zona (ataques a distancia y
      habilidades `unit` que cruzan el borde = desviados, sin daño). La vista previa lo enseña.

### Fase 10 — Empujes, props y metal (GDD §5)

- [ ] **10.1 Datos de los props.** `metallic` y `size: small | large | fixed` en
      PropComponent, en lugar de `pushable`/`throwable`/`pushDistance`. Migrar los props que ya
      existen.
- [ ] **10.2 Metal portado** en las unidades (`metallic` en el prefab; más adelante saldrá del
      equipo) y la etiqueta `giant` (inmune a empuje y tirón).
- [ ] **10.3 Efecto `steelPush`.** Línea recta alejándose del lanzador, `3 + POT/2` m; solo
      sobre lo metálico; si el objetivo es Fijo, sale despedido el lanzador.
      _Hecho cuando:_ `phase10_push`: caja metálica empujada, caja de madera rechazada, empuje
      contra una farola mueve al lanzador.
- [ ] **10.4 Efecto `ironPull`**: hacia el lanzador; un enemigo con armadura metálica llega
      Derribado.
- [ ] **10.5 Efecto `disarm`**: un arma metálica cambia el ataque del enemigo por uno débil.
- [ ] **10.6 Regla de impacto.** Daño = base por tamaño (6/10) + POT o FUE según cómo se lanzó;
      Grande → Aturdido, Pequeño → Derribado; contra un muro +50 %; unidad contra unidad, las dos
      reciben daño.
- [ ] **10.7 Salto de acero.** Distancia `6 + POT` m y sin gastar movimiento. Generalizar
      `jumpArc` (hoy `MAX_JUMP` = 4,5) para que acepte una distancia máxima.
- [ ] **10.8 Lanzar (acción básica).** Prop Pequeño, en arco, a 6 m, escala FUE. Adaptar el
      `throw` que ya existe.
- [ ] **10.9 Vista previa** de las trayectorias de empuje, tirón y rebote (AimArrow /
      PathPreview), con los objetivos afectados marcados.

### Fase 11 — Reacciones y asistencias (GDD §7) ⚠️ el sistema más arriesgado

- [ ] **11.1 Reacción** por unidad y por ronda (hoy los recursos solo existen para la unidad
      activa: hace falta un estado por unidad que se reponga al empezar su turno).
- [ ] **11.2 Bus de disparadores**: `impact`, `airborne`, `offbalance`/`prone`, `crit`, `kill`,
      emitidos desde los puntos de resolución de EncounterComponent con origen, objetivo y quién
      causó la acción original.
- [ ] **11.3 Definición de asistencias en datos**: `assist: { trigger, skill }` en el prefab de
      cada personaje.
- [ ] **11.4 Cola de resolución.** No se reacciona a las acciones propias, una por ronda, rango
      y línea de visión, las físicas se pueden hacer estando Seco, tope de 3 eslabones y bonus de
      cadena ×1,1/×1,2/×1,3.
      _Hecho cuando:_ `phase11_chain`: la cadena de ejemplo del GDD sale entera y se para en el
      eslabón 3.
- [ ] **11.5 Previsualización de la cadena.** Simulación en seco al apuntar: retratos de los
      aliados que van a reaccionar; los eslabones que dependen de un crítico se marcan como
      "si hay crítico".
- [ ] **11.6 Interruptor por personaje**: automático / preguntar / nunca. En "preguntar", la
      cadena se pausa y sale un aviso.
- [ ] **11.7 Presentación**: cámara de acción en las cadenas, contador "Cadena ×2" y ActionText.
- [ ] **11.8 Reacciones defensivas** con la misma Reacción (las usarán la Burbuja de acero, la
      Guardia y la Mente de oro).
- [ ] **11.9 IA**: los enemigos de élite pueden tener asistencias, y la IA intenta cortar las
      cadenas del jugador (Aplacar, matar al que remata).

### 🎯 Escenario de validación del Hito 2

- [ ] **`phase12_patio`**: Lanzamonedas + Deslizador contra 4 guardias (2 con placas, 1 con
      aluminio) en un patio con cajas, una farola y un charco (GDD §15).
      _Hecho cuando:_ se juega entero sin errores. **Decisión de seguir o no:** si el combate no es
      divertido con dos personajes, se revisan el metal, los empujes y las asistencias antes de
      seguir.

### Fase 9 — Estados (GDD §6)

- [ ] **9.1 Ampliar `UnitStatusId`**: `stunned` (Aturdido), `prone` (Derribado), `airborne`
      (Lanzado), `offbalance` (Desequilibrado), `marked` (Marcado), `enraged` (Enfurecido),
      `soothed` (Aplacado), `drained` (Seco). Decidir si `fear` se queda o se sustituye por Calma.
- [ ] **9.2 Reglas de cada estado:**
  - [ ] Aturdido: pierde la próxima Acción.
  - [ ] Derribado: levantarse cuesta la mitad del movimiento; los ataques melee contra él son crítico garantizado.
  - [ ] Lanzado: en el aire hasta el final del turno; al caer, daño y Derribado.
  - [ ] Desequilibrado: +25 % al siguiente golpe que reciba; se consume.
  - [ ] Marcado: +50 % e ignora el rango de armadura; se consume; dura 2 turnos.
  - [ ] Enfurecido: objetivo forzado (la IA tiene que respetarlo), +25 % de daño hecho, −3 de armadura.
  - [ ] Aplacado: sin Reacción y −25 % de daño.
        _Hecho cuando:_ `phase9_statuses` cubre cada estado con una aserción.
- [ ] **9.3 Iconos de estado** sobre la unidad y en el retrato, con tooltip.
- [ ] **9.4 IA**: evalúa los estados (no ataca a quien está protegido, aprovecha a los
      Derribados, obedece al Enfurecido).

---

## HITO 3 — Party completa

### Fase 13 — Voz (GDD §10.3)

- [ ] Leer intenciones: muestra el TurnPlan que la IA tiene previsto para un enemigo (o para
      todos a 6 m si se aviva). Requisito: que la IA planifique su turno **antes** y lo
      mantenga, o que se vuelva a planificar de forma determinista.
- [ ] Provocar: Enfurecido con un objetivo forzado que elige la Voz (puede ser ella misma).
- [ ] Arenga: un aliado gana +2 m de movimiento y +20 % de daño ese turno.
- [ ] Aplacar: en un enemigo, Aplacado y le quita los buffs; en un aliado, le quita los estados
      negativos.
- [ ] Calma: el enemigo no es hostil durante 1 turno; se rompe si recibe daño.
- [ ] Nube de cobre (zona): inmunidad a los estados mentales y ocultación frente al bronce.
- [ ] Duraluminio: Oleada (Enfurecido o Aplacado en área de 8 m).
- [ ] Asistencia: Encender (BAJA o CRÍTICO de un aliado → ese aliado gana 1 Acción adicional;
      cuesta 1 de metal).

### Fase 14 — Artificiera (GDD §10.4)

- [ ] Cargas por combate: `base + ⌊TEM/4⌋`, con su contador en el HUD.
- [ ] Munición cambiable (Acción adicional): normal / aluminio (atraviesa la Burbuja de acero) /
      dardo de cromo (aplica Seco, 2 por combate).
- [ ] Granada de cadmio (zona): movimiento ×0,5 y **se actúa al final de la ronda** (hace falta
      poder reordenar la iniciativa en caliente) y el borde bloquea proyectiles.
- [ ] Pulso de ettmetal: empuje radial de 4 m sobre todo lo metálico.
- [ ] Carga de ettmetal: etiqueta en un prop que lo hace explotar al recibir un IMPACTO. Nueva
      superficie de **agua** con la que el ettmetal reacciona.
- [ ] Inyector de oro: cura a un aliado adyacente `12 + POT`.
- [ ] Asistencia: Detonación (IMPACTO → área de 2 m y Desequilibrado; si el prop lleva
      ettmetal, explota).
- [ ] Liberar mente espiritual y su duraluminio, _Decantación total_ (en la fase 15).

### Fase 15 — Zonas espirituales (GDD §8)

- [ ] Fortuna: +2 canicas de crítico en la bolsa de quien ataca desde dentro.
- [ ] Conexión: un estado aplicado dentro se copia al resto de unidades del mismo bando que
      estén dentro.
- [ ] Investidura: las habilidades lanzadas desde dentro cuentan como Avivadas gratis.
- [ ] Afectan a **los dos bandos**; la IA lo tiene en cuenta (evita las zonas que le perjudican
      y aprovecha las que le benefician).
- [ ] Habilidad de la Artificiera: una zona activa a la vez, durante 3 turnos.
- [ ] Relicarios: props metálicos que emiten una zona; se mueven con empuje y tirón; al
      romperse, sueltan la zona de golpe durante 1 ronda.
      _Hecho cuando:_ `phase15_zones`: el Lanzamonedas atrae un relicario de Conexión y un
      Enfurecido se reparte entre 3 enemigos.

### Fase 16 — Variantes de duraluminio y repaso de equilibrio

- [ ] Una variante por personaje (Meteoro, Mil golpes, Oleada, Decantación total).
- [ ] Tabla de daño por ronda (GDD §10.0) medida con escenarios automáticos: sostenido y pico
      de cada personaje, y ajuste de números.

---

## HITO 4 — Capa RPG

### Fase 17 — Equipo y feruquimia (GDD §9)

- [ ] **17.1 Inventario y equipo** (no existe): ranuras de arma, armadura y 2 mentes de metal;
      UI en la ficha de personaje.
- [ ] **17.2 Armaduras**: cuero / placas (metal portado → se le puede empujar, atraer y desarmar)
      / aluminio (inmune al empuje). La armadura y la etiqueta `metallic` pasan a salir del equipo.
- [ ] **17.3 Sistema genérico de mentes de metal**: cargas, empiezan el combate con 1 cargada,
      almacenar (penalización este turno → +1 carga) y decantar (beneficio).
- [ ] **17.4 Las 11 mentes de la tabla del GDD**: oro, peltre, acero, hierro, estaño, cinc,
      bronce, electrum, cromo, latón y cobre.
- [ ] **17.5 Armas**: daño base, alcance, si son metálicas (pueden desarmarse) y penetración.

### Fase 18 — Progresión (GDD §14)

- [ ] XP y niveles; vida `+5` por nivel.
- [ ] 2 puntos de atributo por nivel con coste creciente (1 / 2 / 3) y su UI de reparto.
- [ ] **Sistema de talentos como modificadores** de las habilidades (parches sobre `SkillDef`:
      +duración, +objetivos, efecto extra).
- [ ] Árboles de 2 ramas por personaje (Aviador/Artillero, Virtuoso/Inmortal,
      Titiritero/Duelista, Ingeniera/Tiradora) con los talentos ya nombrados en el GDD: Rebote,
      Finta, Pullas, Arrollar, Peltre templado, Réplica…
- [ ] Hitos de nivel que dan acciones extra (segunda Reacción, segunda carga de duraluminio).

### Fase 19 — Enemigos (GDD §13)

Cada uno con su prefab, su perfil de IA y un escenario que demuestre su contrajuego:

- [ ] Guardia con placas (metal portado)
- [ ] Guardia con aluminio (inmune al empuje)
- [ ] Koloss (Gigante, muy sensible a las emociones)
- [ ] Lanzamonedas enemigo (empuja y desarma a la party si lleva metal)
- [ ] Aplacador enemigo (quita Reacciones)
- [ ] Ahumador (nube de cobre: anula Leer intenciones)
- [ ] Inquisidor de Acero (élite con asistencias)
- [ ] Kandra (disfraz; se detecta con bronce o Agudeza)

---

## HITO 5 — Fuera del combate (GDD §12)

### Fase 20 — Exploración

- [ ] **20.1 Viales** como recurso de exploración (inventario, 17.1).
- [ ] **20.2 Pruebas deterministas**: dificultad visible; pasas si tu atributo llega o pagas
      1 vial por cada punto que falte; también se puede buscar otra solución.
- [ ] **20.3 Elementos interactuables**: cerraduras, trampas, puertas forzables, palancas
      lejanas, escombros.
- [ ] **20.4 Bruma con efecto en el juego**: límite de apuntado `6 + AGU` m dentro de la bruma
      froxel y sigilo de noche. Desbloquea la Vista de estaño (12b).
- [ ] **20.5 Una lente por personaje:**
  - [ ] Líneas azules: modo de visión que resalta el metal (trabajo de render: overlay o
        post-proceso).
  - [ ] Estaño: oír tras las paredes, oler la pólvora.
  - [ ] Deslizar para pasar patrullas o trampas.
  - [ ] Peltre para forzar puertas.
  - [ ] Bronce para detectar alomantes que se esconden; cobre para ocultar a la party.
  - [ ] Cerraduras y trampas mecánicas, fabricar viales y cargas.
  - [ ] Cobre feruquímico: diario de pistas.

### Fase 21 — Social (requiere un sistema de diálogo, que no existe)

- [ ] Sistema de diálogo con opciones condicionadas por personaje, atributo o coste.
- [ ] Aplacar y Encender en los diálogos (Voz), disfraces y acentos (Deslizador), intimidar
      (Lanzamonedas), conocimiento técnico (Artificiera).

---

## Decisiones pendientes que bloquean tareas

- [ ] ¿Se quitan los dados del daño del todo? (7.4)
- [ ] ¿`fear` se queda como estado? (9.1)
- [ ] Justificación narrativa de los personajes con varios metales (GDD §17)
- [ ] Nombres de los 4 personajes (12.1)

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
