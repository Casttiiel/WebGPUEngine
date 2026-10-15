# GDD — Combate táctico Mistborn (Era 1 + Era 2)

> Documento de diseño que parte de [TODO.md](TODO.md). Las decisiones vienen razonadas con la
> teoría que usamos en diseño (MDA, leyes de Sanderson, economía de acciones, enabler/payoff,
> aleatoriedad de entrada vs. salida, *progressive disclosure*…). Lo que está marcado como
> **[DECIDIR]** es una elección tuya; lo demás es mi recomendación.

---

## 0. Pilares de diseño

Los pilares son el filtro de cada decisión: si una mecánica no sirve a al menos uno, se corta.

1. **El metal es el recurso.** Cada habilidad tiene un coste y quedarse seco duele. Es la
   tensión central de riesgo/recompensa (*push your luck*): ¿lo quemo todo ahora o aguanto?
2. **El escenario es un arma.** Cajas, farolas, verjas, cadenas: todo lo metálico o pesado es
   munición. Diseño sistémico: unas pocas reglas físicas → muchas situaciones emergentes.
3. **La party es un instrumento.** Cuatro personajes juntos valen más que la suma. Cada uno
   *prepara* (enabler) lo que otro *remata* (payoff).
4. **Magia dura, reglas legibles.** La alomancia de Sanderson es un sistema "duro": el jugador
   tiene que poder predecir qué va a pasar antes de pulsar el botón.

### Las leyes de Sanderson aplicadas al diseño
Sanderson las escribió para novelas, pero valen tal cual para diseño de juegos:

| Ley | En el libro | En el juego |
|---|---|---|
| 1ª: la capacidad de resolver conflictos con magia es proporcional a lo bien que el lector la entiende | Por eso Vin gana con empujes que entendemos | **Todo se previsualiza**: rango de daño, trayectoria del empuje, qué aliados reaccionan |
| 2ª: las limitaciones son más interesantes que los poderes | Solo se puede empujar metal, y el metal hay que quemarlo | **El coste del metal y "solo lo metálico"** son lo que crea decisiones, no el poder en sí |
| 3ª: amplía lo que tienes antes de añadir algo nuevo | Duraluminio, metales temporales... ¡todo usa las mismas reglas! | Las zonas de Fortuna/Conexión/Investidura **reutilizan sistemas que ya existen** (ver §8) |

### Estéticas objetivo (MDA)
De las 8 estéticas de Hunicke/LeBlanc/Zubek, buscamos: **Desafío** (combate táctico),
**Fantasía** (sentirse como Vin o Wax), **Compañerismo** (sinergia de la party, aunque sea
para un solo jugador) y **Expresión** (varias soluciones para cada combate). Si una mecánica
no apoya ninguna de estas cuatro, sobra.

---

## 1. Economía de acciones

Partimos de lo que ya tiene el motor (estilo BG3) y añadimos la Reacción:

| Recurso | Por turno | Para qué sirve |
|---|---|---|
| **Movimiento** | metros (según Reflejos) | Desplazarse. El salto de acero NO gasta movimiento |
| **Acción** | 1 | Ataques, habilidades principales |
| **Acción adicional** | 1 | Habilidades menores, beber vial, cambiar munición |
| **Reacción** | 1 por **ronda** | Asistencias/combos, contraataques, burbuja de acero |
| **Reserva de metal** | barra (ver §2) | Coste de toda la alomancia |

> ⚠️ **Lo de "número de acciones por turno" NO debería ser una estadística que suba de forma
> continua.** La economía de acciones es la palanca más fuerte de un juego por turnos: una
> acción extra equivale a +100 % de daño. En BG3, "Ataque extra" es un hito de nivel, no un
> número que se va subiendo. Recomiendo que las acciones extra vengan solo de **efectos
> concretos y limitados**: burbuja de bendaleo, mente de acero (velocidad), la reacción de la
> Voz al hacer una baja. Así las acciones extra son *momentos*, no la base.

---

## 2. La Reserva de metal y el estado "Seco"

### Tu idea, con dos ajustes
- Cada personaje tiene una **Reserva** con números pequeños (≈ 8–12 puntos). Que no sea de
  100: los enteros pequeños se leen de un vistazo (menos carga cognitiva) y cada punto pesa.
- Las habilidades cuestan **1–4**. El autoataque y las acciones físicas (empellón, lanzar algo
  ligero a mano) son **gratis**.
- **Al llegar a 0 → Seco.** En tu siguiente turno no puedes usar alomancia (te estás bebiendo
  el vial). **Al terminar ese turno, la Reserva se llena entera.**
- **Recarga voluntaria:** con una Acción adicional te declaras Seco por tu cuenta (recargas al
  final del turno siguiente). Es como recargar en XCOM: tú eliges cuándo pagar el coste.

**Ajuste 1 — Que estar Seco nunca sea un turno muerto.** Regla de oro del diseño por turnos:
*nunca le quites el turno al jugador*. Estando Seco **sí puedes** moverte, usar el autoataque,
empujar props a mano, usar objetos, **mentes de metal (feruquimia)** y **asistencias físicas**.
Lo único que pierdes es la alomancia. Así ese turno sigue teniendo decisiones, pero distintas
(y le da valor a los props y la feruquimia, que es justo lo que queremos).

**Ajuste 2 — Avivar (flare).** Opcional, pero muy de los libros: cualquier habilidad se puede
*avivar* pagando +50 % del coste (redondeando hacia arriba) a cambio de +50 % de efecto. Da
expresión sin crear habilidades nuevas.

### Ritmo que sale de esto
`Quemar → Quemar → (Duraluminio) → Seco (turno físico) → Reserva llena → …`
Es un ciclo de tensión y alivio. Un combate dura unas 4–6 rondas, así que cada personaje
pasará por Seco 1 o 2 veces: suficiente para que sea una decisión, no un castigo constante.

### Seco también es un estado que se puede aplicar
El **cromo** (alomancia de cromo: borrar los metales de otro) aplica *Seco* a un enemigo
alomántico. Es la habilidad de "silencio" que tenías en el TODO, pero **reutilizando una regla
que ya existe** (3ª ley) en vez de inventar un estado nuevo.

---

## 3. Atributos y estadísticas

### Filosofía
1. **Los atributos son libres.** Cualquier personaje puede subir cualquier atributo. La
   identidad viene de **su kit de habilidades y su reparto inicial**, no de un atributo
   obligatorio. Si quieres una Voz que pegue con el estoque, puedes hacerla.
2. **Cada atributo hace una sola cosa.** Nunca hay ataque y defensa en el mismo atributo: así
   cada punto es una renuncia (cañón de cristal frente a tanque). Si un atributo diera vida y
   daño a la vez, sería una estrategia dominante y todos los personajes lo subirían.
3. **Separar la intensidad del aguante.** Lo que hace fuerte cada golpe y lo que te deja
   aguantar más golpes van en atributos distintos. Pasa lo mismo con la magia: la **potencia
   de cada habilidad** y **cuántas puedes lanzar** (la Reserva) van separadas. Si no,
   Potencia sería el único atributo que importa para un usuario de magia.

### Seis atributos en tres pares

| Par | Intensidad | Aguante |
|---|---|---|
| **Cuerpo** | **Fuerza** (FUE) | **Resistencia** (RES) |
| **Alomancia** | **Potencia** (POT) | **Temple** (TEM) |
| **Instinto** | **Reflejos** (REF): tempo | **Agudeza** (AGU): precisión |

| Atributo | En combate | Fuera del combate |
|---|---|---|
| **Fuerza** | Daño físico (melee **y** a distancia: armas, autoataque, técnicas de bastón) | Forzar, romper, levantar |
| **Resistencia** | Vida y curación recibida | Aguantar venenos, frío, ceniza, caídas |
| **Potencia** | Daño de las habilidades alománticas, **duración** de los estados que aplicas, **distancia** de empuje, tirón y salto | Leer metales, alcance de los pulsos de bronce, influencia emocional en los diálogos |
| **Temple** | **Reserva máxima** y resistencia a los estados mentales (Enfurecido, Aplacado). En la Artificiera, también cargas de gadgets | Resistir interrogatorios, mentiras, alomancia emocional en los diálogos |
| **Reflejos** | Movimiento, iniciativa, daño de asistencia | Sigilo, acrobacias, robar |
| **Agudeza** | % de crítico, penetración de armadura, **percepción en combate** | Trampas, cerraduras, pistas |

**Sobre tu propuesta de un atributo para toda la magia:** estoy de acuerdo con que Potencia
mejore *todo lo que hace* una habilidad (daño, duración y distancia), porque es lo que hace el
"poder mágico" en cualquier RPG y se entiende enseguida. El problema era sumarle también la
Reserva máxima: entonces Potencia te haría más fuerte **y** te dejaría lanzar más veces. Con la
Reserva en Temple, Potencia es *intensidad* y Temple es *volumen*. Es la decisión clásica de
golpes fuertes frente a aguante: ¿pocas habilidades enormes o muchas normales?

**Sobre si a Agudeza le faltaba algo:** le añado **percepción en combate**. Sirve para ver a
través de la bruma (alcance de apuntado dentro de la bruma: `6 + AGU` m), detectar enemigos
ocultos y emboscadas, y ver las trampas del campo de batalla. **No** le añadiría daño crítico:
el crítico ya ignora la armadura, así que con daño crítico Agudeza se volvería el mejor atributo
de daño (el típico problema de los ARPG en los que todo el mundo acaba acumulando crítico).

### Estadísticas derivadas (primera versión, para afinar jugando)

| Estadística | Fórmula |
|---|---|
| Daño físico | `arma + FUE` |
| Vida | `25 + 6·RES + 5·(nivel−1)` |
| Curación recibida | `+5 % por punto de RES` |
| Daño de habilidad alomántica | `base de la habilidad + POT` |
| Duración de los estados que aplicas | `base + 1 turno con POT 4 y otro con POT 8` |
| Distancia de empuje/tirón | `3 + POT/2` m |
| Distancia del salto de acero | `6 + POT` m |
| Reserva máxima | `6 + TEM` |
| Resistencia mental | Los estados mentales que recibes duran 1 turno menos con TEM 5 y 2 menos con TEM 9 (mínimo 1) |
| Cargas de gadgets (Artificiera) | `base + ⌊TEM/4⌋` |
| Movimiento | `6 + REF/2` m |
| Iniciativa (individual) | `2·REF + 1d4` |
| Daño de asistencia | `50 % del autoataque + REF` |
| % de crítico | `5 % · (1 + ⌊AGU/2⌋)`, siempre múltiplo de 5 % (bolsa de 20 canicas como mucho) |
| Penetración | `⌊AGU/2⌋` |

La **armadura** sale solo del equipo, no de un atributo (ver §9).

### Cada habilidad dice con qué escala
Cada habilidad lleva una etiqueta **Escala: FUE / POT / AGU…**. Un mismo personaje tiene
habilidades que escalan con atributos distintos, y eso es lo que hace posibles las builds:
- Las **técnicas de bastón** y el **peltre** del Deslizador (Proyección, autoataque) escalan con **FUE**; sus
  **burbujas de bendaleo**, con **POT** (duración y tamaño); y su **mente de oro**, con **RES**.
  Un Deslizador puede ser virtuoso del golpe o casi inmortal según dónde ponga los puntos.
- Las de **acero/hierro** y las **emocionales** escalan con **POT**.
- El **autoataque** y las armas escalan con **FUE** (y con AGU para los críticos).
- Los **gadgets** de la Artificiera escalan con **POT** (el ettmetal y las mentes de metal son
  Investidura).

### Coste creciente: especializarse se puede, pero sale caro

| Subir a… | 2–6 | 7–8 | 9–10 |
|---|---|---|---|
| Coste por punto | 1 | 2 | 3 |

- Se ganan **2 puntos por nivel**.
- Llevar un atributo de 6 a 10 cuesta 10 puntos. En toda la campaña te da para llevar **uno o
  dos atributos al máximo**, no más.
- Así, **especializarse es posible pero caro**, y repartir es más eficiente. Esto responde a tu
  preocupación por el Lanzamonedas: tener mucha vida (RES), mucha movilidad (REF y POT) **y**
  disparar fuerte (FUE y AGU) son 4 o 5 atributos distintos, y no hay puntos para todo. O es un
  cañón de cristal o es duro, pero no las dos cosas.

### Reparto inicial (24 puntos, mínimo 2)

| | FUE | RES | POT | TEM | REF | AGU |
|---|---|---|---|---|---|---|
| **Lanzamonedas** | 4 | 2 | 6 | 3 | 5 | 4 |
| **Deslizador** | 4 | 5 | 3 | 3 | 5 | 4 |
| **Voz** | 2 | 3 | 6 | 6 | 3 | 4 |
| **Artificiera** | 3 | 3 | 4 | 5 | 4 | 5 |

El reparto inicial **sugiere** un estilo de juego, pero a partir de ahí el jugador decide.

### Dos builds por personaje
Cada personaje tiene un árbol de talentos con **dos ramas**. Son una dirección, no son
exclusivas: puedes coger talentos de las dos. Los talentos son **modificadores de habilidades
que ya tienes** (§14), así que la barra de habilidades no crece.

| Personaje | Rama A | Rama B |
|---|---|---|
| **Lanzamonedas** | **Aviador** (POT, REF): saltos más largos, empujes de props, Meteoro | **Artillero** (FUE, AGU): revólver, bala empujada, marca del cazador, críticos y penetración. Talento *Rebote* (la bala empujada rebota en el metal) |
| **Deslizador** | **Virtuoso** (REF, AGU, FUE): Ritmo, Finta, Proyección, críticos | **Inmortal** (RES, TEM): más cargas de oro, Guardia más frecuente, Pullas, burbujas más largas |
| **Voz** | **Titiritero** (POT, TEM): control de grupos, duraciones largas, oleada | **Duelista** (FUE, REF): estoque, réplica a los Enfurecidos, se puede elegir como objetivo de su propio Provocar |
| **Artificiera** | **Ingeniera** (POT, TEM): burbujas, zonas, más cargas | **Tiradora** (AGU, FUE): munición especial, escopeta, detonación de asistencia |

**Ejemplo, la Voz Duelista:** usa *Provocar* sobre un grupo eligiéndose a sí misma como objetivo
del ataque. Con el talento *Réplica*, cada enemigo Enfurecido que la ataca recibe un
contraataque con el estoque (escala FUE). Con *Arenga* sobre sí misma, +20 % de daño. Es un
estilo de juego de duelista que provoca a los enemigos, construido con las mismas habilidades
que la Voz Titiritera usa para controlar.

> **Regla de diseño que hay que vigilar:** cada personaje tiene que tener **al menos dos builds
> viables**. Si una rama no aguanta en los combates de prueba, es una trampa para el jugador
> (una *trap build*) y hay que reforzarla.

---

## 4. Daño, armadura y crítico

### Por qué "aciertas siempre" es buena decisión
En diseño se distingue **aleatoriedad de entrada** (pasa *antes* de decidir: robar cartas, el
mapa) de **aleatoriedad de salida** (pasa *después*: la tirada para impactar). La de salida
genera la frustración del "95 % y fallo" de XCOM. Tú quitas la tirada binaria (acierto/fallo)
y dejas solo una **varianza acotada en el daño**, que el jugador puede planificar. Bien.

### Fórmula de armadura → rango de daño

```
A_ef     = max(0, Armadura − Penetración)
mitig    = A_ef / (A_ef + K)              K = 12
Daño máx = D
Daño mín = round(D · (1 − mitig))
Daño     = entero uniforme en [mín, máx]
```

Con tu ejemplo: `D = 10, A = 5 → mitig = 5/17 = 0,29 → 7–10`. ✔

| Armadura | mitig | D = 10 | D = 20 | Daño medio |
|---|---|---|---|---|
| 0 | 0 % | 10 | 20 | 100 % |
| 3 | 20 % | 8–10 | 16–20 | 90 % |
| 5 | 29 % | 7–10 | 14–20 | 85 % |
| 8 | 40 % | 6–10 | 12–20 | 80 % |
| 12 | 50 % | 5–10 | 10–20 | 75 % |
| 20 | 63 % | 4–10 | 8–20 | 69 % |

**Por qué esta forma:**
- **Hiperbólica** (la misma familia que la armadura de LoL): rendimientos decrecientes, nunca
  llega a inmunidad y un enemigo acorazado no se vuelve imposible.
- **El máximo no baja nunca**: la armadura no te quita daño "seguro", te quita *certeza*. El
  daño medio baja como mucho a la mitad. La armadura se vuelve una variable de planificación
  ("si saco 8 o más, lo mato") en lugar de un muro.
- **K = 12** es el único número que tocar para afinar. Si la armadura sube mucho con el nivel,
  haz que K suba con el nivel.

### Crítico
- Usa la **bolsa de canicas** que ya tienes (UnitComponent).
- **Un crítico ignora el rango de armadura**: hace `máx × 1,5`. Fantasía: "encontraste el
  hueco". Así el crítico vale más cuanto más acorazado es el enemigo, que es justo cuando el
  jugador lo necesita.
- El crítico es **disparador de asistencias** (§7).

### UI (obligatoria por la 1ª ley)
Al apuntar se ve: `7–10 (crítico 15)`, un icono de **letal** si el mínimo ya mata o de
**posible letal** si lo hace el máximo, y los aliados que van a reaccionar.

### Tipos de daño
Para no tener dos armaduras: **todo el daño que alguien recibe es cinético** (balas, puños,
cajas, monedas), así que la armadura afecta siempre. La alomancia emocional no hace daño,
aplica estados. Muy pocas habilidades tienen la etiqueta **Directo** (ignora la armadura): la
explosión de ettmetal.

---

## 5. Empujes, tirones y props

Sin masa. Reglas simples y fáciles de leer:

- **Empuje y Tirón solo afectan a lo metálico**: props de metal y unidades con **metal
  portado** (armadura o arma metálica). Lo que no lleva metal no se puede mover con alomancia.
- **Distancia** = `3 + POT/2` m. El Empuje va en línea recta alejándose de ti; el Tirón, hacia ti.
- Los **props** tienen un tamaño: **Pequeño**, **Grande** o **Fijo** (anclado: farolas,
  verjas, raíles). Lo Fijo no se mueve.
- Las unidades **Gigantes** (koloss) no se pueden empujar ni atraer.
- El **salto de acero** es su propia habilidad: `6 + POT` m.

### Impactos
```
Daño de impacto = base del prop (Pequeño 6, Grande 10) + atributo de quien lo lanza
```
El atributo es **POT** si se lanza con un empuje y **FUE** si se lanza a mano o de un golpe (bateo).

- Prop **Grande** → **Aturdido** (pierde su próxima Acción).
- Prop **Pequeño** o unidad lanzada → **Derribado**.
- Si una unidad lanzada **choca contra un muro**: +50 % de daño. Si choca contra otra unidad,
  las dos reciben daño.
- Todo impacto es el disparador **IMPACTO** (§7).

---

## 6. Estados (vocabulario de combate)

Pocos y bien definidos. Cada palabra nueva es un coste cognitivo, así que el objetivo son unos
8 como mucho, y todos se pueden aplicar en ambas direcciones (jugador ↔ enemigo).

| Estado | Efecto | Lo aplica sobre todo |
|---|---|---|
| **Aturdido** | Pierde su próxima Acción | Impacto de prop Grande, mente de peltre |
| **Derribado** | Levantarse cuesta la mitad del movimiento; los ataques melee contra él son crítico garantizado | Tirón de hierro, impacto ligero, Proyección |
| **Lanzado** | En el aire hasta el final del turno; al caer recibe daño y queda Derribado | Empuje hacia arriba, bateo |
| **Desequilibrado** | El siguiente golpe que recibe hace +25 % y se consume | Muchas habilidades. Es la "preparación" universal |
| **Marcado** | El siguiente golpe de cualquier aliado hace +50 % e ignora el rango de armadura (se consume). Dura 2 turnos | Marca del cazador |
| **Enfurecido** | Tiene que atacar al objetivo que elijas; +25 % al daño que hace y −3 de armadura | Encender (cinc) |
| **Aplacado** | Sin Reacción y −25 % de daño | Aplacar (latón) |
| **Seco** | Sin alomancia este turno | Quedarse sin Reserva, cromo |

---

## 7. Asistencias / combos

### Referentes
Las reacciones de BG3, los combos elementales de Divinity: Original Sin 2, el "One More"
de Persona y el *break* de Octopath. Lo que tienen en común:
**un disparador legible → una respuesta automática → un tope que evita bucles infinitos**.

### Reglas
1. **Cinco disparadores**, ni uno más:
   - **IMPACTO**: un prop o una unidad choca contra algo.
   - **LANZADO**: un enemigo sale volando.
   - **DESEQUILIBRADO / DERRIBADO**: se aplica ese estado.
   - **CRÍTICO**: un aliado hace un crítico.
   - **BAJA**: un aliado mata a un enemigo.
2. Cada personaje **escucha uno o dos** disparadores (su "lectura" del combate).
3. La asistencia **gasta la Reacción** (una por ronda) y necesita rango y línea de visión.
   Las asistencias físicas se pueden hacer estando Seco.
4. **Una asistencia puede disparar la asistencia de otro aliado, pero no la tuya.** Como hay
   una Reacción por ronda, la cadena tiene un **tope natural de 3 eslabones**. Sin bucles
   infinitos y sin reglas extra.
5. **Bonus de cadena**: cada eslabón suma +10 % de daño acumulado (×1,1 → ×1,2 → ×1,3).
   Contador en pantalla y la cámara de acción que ya tienes (ActionCameraComponent) para el
   *juice*.
6. **Previsualización**: al apuntar una acción, salen los retratos de los aliados que van a
   reaccionar. Sin esto, los combos son azar. Con esto, son *planificación* (1ª ley).
7. Interruptor por personaje: **automático / preguntar / nunca** (como las reacciones de BG3),
   para guardar la Reacción por si hace falta para defenderse.

### La asistencia de cada personaje

| Personaje | Disparador | Asistencia | Efecto |
|---|---|---|---|
| **Lanzamonedas** | LANZADO o DESEQUILIBRADO | *Tiro al plato* | Disparo con el daño de asistencia. Contra un objetivo Lanzado, +50 % |
| **Deslizador** | DERRIBADO, o un enemigo que **llega empujado a su lado** | *Bateo* | Golpe melee que además **redirige** al enemigo 3 m hacia donde tú elijas (provoca un nuevo IMPACTO) |
| **Voz** | BAJA o CRÍTICO de un aliado | *Encender el ánimo* | Ese aliado gana **1 Acción adicional** inmediata (cuesta 1 de metal) |
| **Artificiera** | IMPACTO | *Detonación* | Dispara al punto de impacto: daño en área de 2 m y Desequilibrado. Si el prop lleva ettmetal, explota |

### Ejemplo de cadena (es tu caso de la caja, ampliado)
1. El **Lanzamonedas** empuja una caja metálica Grande contra un guardia → **IMPACTO** (daño,
   Aturdido).
2. → La **Artificiera** reacciona con *Detonación* en el punto de impacto: el guardia y su
   compañero quedan **Desequilibrados**. (Eslabón 1, ×1,1)
3. → El compañero Desequilibrado sale despedido junto al **Deslizador**, que reacciona con
   *Bateo* → **crítico**, y lo devuelve contra la caja (nuevo IMPACTO). (Eslabón 2, ×1,2)
4. → La **Voz** reacciona a ese crítico con *Encender*: el Deslizador gana una Acción adicional
   y la usa para *Deslizar* a la espalda del guardia aturdido. (Eslabón 3, tope)

> Ojo: **nadie reacciona a sus propias acciones**. Por eso el Lanzamonedas, que empezó la
> cadena, no puede hacer *Tiro al plato* en ella.

Cuatro personajes, una sola acción del jugador y todo previsible en la vista previa. Es el
pilar 3 hecho mecánica.

### Simetría
Los grupos de enemigos de élite (una cuadrilla de Inquisidores o lanzamonedas a sueldo)
**usan las mismas reglas de asistencia**. El jugador aprende el sistema viéndolo usado contra
él, y a la vez entiende cómo cortarlo: Aplacar quita la Reacción y matar al que remata rompe
la cadena.

---

## 8. Zonas de Fortuna, Conexión e Investidura

### El lore las ordena solas
En la feruquimia de la Era 2, los tres metales "espirituales" guardan exactamente esto:
**cromo = Fortuna, duraluminio = Conexión, niquelsil = Investidura**. Así que las zonas son
**mentes de metal espirituales que se liberan en un área**.

### Qué hace cada una (reutilizando sistemas existentes, 3ª ley)
| Zona | Efecto | Sistema que reutiliza |
|---|---|---|
| **Fortuna** | Quien ataca desde dentro mete +2 canicas de crítico en su bolsa | La bolsa de canicas |
| **Conexión** | Un estado aplicado a una unidad que está dentro se copia a todas las de su bando que también estén dentro | Los estados |
| **Investidura** | Las habilidades que se usan desde dentro cuentan como **Avivadas gratis** (+50 %) | Avivar |

**Afectan a todos, también a los enemigos.** Eso es lo que las hace tácticas: una zona de
Conexión con tres enemigos dentro es perfecta para meter un Enfurecido o un Aplacado... y
terrible si es tu party la que está dentro cuando el enemigo te aplica algo.

### ¿Objeto, habilidad o prop? → Prop del escenario + habilidad de un personaje
- **Como objeto equipable, no**: si todos pueden crearlas, nadie es especial y el combate se
  vuelve un "pon la zona y luego juega".
- **Prop del escenario: sí, como fuente principal.** "Relicarios" (cristales o cofres de metal
  espiritual) colocados en ciertos combates. **Y son props metálicos**, así que el
  Lanzamonedas puede atraerlos o empujarlos para **mover la zona**. Esto es diseño sistémico en
  estado puro: la zona entra en la física del acero sin ninguna regla nueva. Si se rompen,
  sueltan la zona de golpe durante una ronda.
- **Habilidad de la Artificiera**: puede crear **una zona a la vez**, durante 3 turnos, con
  cargas limitadas. Es su identidad.

### ¿Son demasiadas mecánicas? (presupuesto de complejidad)
Cuenta de sistemas: Reserva/Seco, economía de acciones, empujes y props, estados,
asistencias, crítico, feruquimia equipable, duraluminio y zonas. Son 9. BG3 tiene bastantes
más; lo que importa no es el número, sino:
- **Elegancia = profundidad / complejidad.** Las zonas pasan el filtro porque **no añaden
  vocabulario**: hablan de canicas, estados y avivar, que ya existen.
- ***Progressive disclosure***: no lo enseñes todo a la vez. Orden recomendado:
  1. Acto 1, inicio: autoataque, Reserva/Seco, props.
  2. Acto 1, mitad: asistencias (cuando tengas los 4 personajes).
  3. Acto 1, final: feruquimia equipable y duraluminio.
  4. Acto 2: relicarios del escenario.
  5. Acto 2, mitad: la Artificiera aprende a crear zonas.
- **Orden de recorte** si hay que quitar algo (del primero en caer al último): Avivar →
  Investidura → Conexión → Fortuna → mentes de metal → asistencias. Las asistencias y los props
  son el corazón del juego; eso no se toca.

---

## 9. Equipo y feruquimia equipable

### Las mentes de metal como objetos: sí, y tiene base en los libros
En *Brazales del Duelo* existen las **mentes de metal no selladas**: cualquiera puede usarlas.
Es la justificación perfecta para la personalización.

- **2 ranuras de mente de metal** por personaje (brazal y anillo).
- **Mecánica de los libros = deuda temporal.** La feruquimia es "más débil ahora, más fuerte
  después". Cada mente:
  - empieza el combate **cargada una vez** (la llenaste mientras explorabas o en el campamento);
  - **Almacenar** (Acción adicional): sufres la penalización este turno y ganas una carga más;
  - **Decantar** (Acción adicional): gastas la carga y te llevas el beneficio.
  Así se convierte en una decisión de tiempo, no en un "una vez por combate" plano.

| Mente | Al almacenar (penalización) | Al decantar (beneficio) |
|---|---|---|
| **Oro** (salud) | −25 % de vida actual | Curación de 6/turno durante 3 turnos |
| **Peltre** (fuerza) | −50 % de daño físico | Siguiente golpe ×2 y Aturdido. *Tu "megaataque"* |
| **Acero** (velocidad) | Movimiento ×0,5 | Movimiento ×2 y +1 Acción adicional. *Tu "megavelocidad"* (ver nota) |
| **Hierro** (peso) | — | Ligero: saltos ×2. Pesado: no te pueden empujar, atraer ni derribar |
| **Estaño** (sentidos) | Ciego más allá de 5 m | +2 canicas de crítico y ves a través de la bruma |
| **Cinc** (velocidad mental) | Último en la iniciativa | Primero en la iniciativa y +1 Reacción |
| **Bronce** (vigilia) | — | Inmune a Aturdido 2 turnos |
| **Electrum** (determinación) | — | La próxima vez que caigas a 0, te quedas a 1 |
| **Cromo** (Fortuna) | Pierdes canicas | Mini zona de Fortuna personal |
| **Latón** (calor) | — | Inmune a las superficies de fuego o hielo |
| **Cobre** (memoria) | — | Sobre todo fuera del combate (§11) |

> **Corrección de lore**: en el TODO pusiste "electrum feruquímico = megavelocidad". En los
> libros, la velocidad física es el **acero** feruquímico (los "corredores de acero"). El
> electrum guarda **determinación**, que encaja muy bien con "no caer a 0".

### Armadura: la decisión de equipo más Mistborn posible
| Tipo | Armadura | Contrapartida |
|---|---|---|
| Cuero, ropa | Baja | Ninguna |
| Placas, cota | Alta | **Metal portado**: te pueden empujar, atraer, derribar y desarmar |
| Aluminio | Media-alta | Inmune al empuje, pero cara y rara |

Esto genera **contrajuego entre las dos partes**: los guardias con placas son tanques contra el
Deslizador, pero juguetes para el Lanzamonedas. Y si tú te pones placas, los lanzamonedas
enemigos te harán lo mismo.

---

## 10. Los 4 personajes

### Lógica del reparto
La alomancia ya viene agrupada en cuadrantes en los libros: **físico, mental, temporal y de
mejora**. Asignar a cada personaje un territorio de metales da identidad, coherencia con el
lore y **cobertura** de roles sin caer en la trinidad de MMO (tanque, sanador, DPS).

Todos son personajes "**twinborn** con extras" (alomancia + feruquimia, como Wax y Wayne en la
Era 2), lo que justifica que cada uno tenga un territorio limitado.

### Por qué no te convencía el Berserker/Bardo
Mezclaba **dos fantasías opuestas** (meterse a pegar con peltre y apoyar con emociones) y
**dos distancias** (melee y apoyo a media distancia). Encima usaba el taunt para *protegerse*
a sí mismo, que va en contra de lo que es un berserker. **La solución es partirlo en dos**: el
Deslizador, que *aguanta* los golpes regenerándose, y la Voz, que *hace* que le peguen a él. El taunt pasa de
ser autoprotección a ser **sinergia**.

### Resumen

| | Lanzamonedas | Deslizador | Voz | Artificiera |
|---|---|---|---|---|
| **Metales** | Acero, hierro, estaño + hierro feruquímico | Bendaleo, peltre + oro feruquímico, técnica de bastones | Cinc, latón, bronce, cobre | Gadgets de ettmetal, cadmio en dispositivos, feruquimia espiritual |
| **Rol** | Daño a distancia, movilidad | Duelista que aguanta regenerándose, primera línea | Control, apoyo | Control del terreno, utilidad |
| **Distancia** | Larga | Cuerpo a cuerpo | Media | Media |
| **Builds** (§3) | Aviador / Artillero | Virtuoso / Inmortal | Titiritero / Duelista | Ingeniera / Tiradora |
| **Complejidad** | ★★☆ | ★☆☆ (el más fácil) | ★★☆ | ★★★ |
| **Referente** | Wax, Vin | Wayne | Brisa (Breeze) | Marasi (Pulsadora, cadmio), Steris |

> Un personaje de complejidad baja (el Lanzamonedas) es importante: es el "personaje de entrada"
> para quien no conoce el sistema, igual que en Overwatch o los MOBA.

### ¿Quién lanza los props?
Tu duda era si darle todos los props al Lanzamonedas. **Mejor que los props sean un lenguaje
compartido**, y que cada personaje los use con una **geometría distinta**:

| Quién | Cómo | Geometría |
|---|---|---|
| Cualquiera | Empellón a mano (ya existe) | 1–3 m, props Pequeños |
| Lanzamonedas | Empuje / tirón | **Línea recta** alejándose o acercándose a él. Distancia según POT |
| Cualquiera | Lanzar (Acción, escala FUE) | **Arco elegido**: un prop Pequeño a 6 m, por encima de la cobertura |
| Deslizador | Bateo y Proyección | **Redirección y arco**: devuelve lo que le llega 3 m hacia donde elijas, o lanza en arco al enemigo con el que está peleando |
| Artificiera | Pulso del cubo | **Radial**: todo lo metálico sale hacia fuera desde un punto |
| Voz | No lanza props | **Mueve a los enemigos hacia los props** (taunt, Enfurecido) |

---

### 10.0 Cómo se equilibra un kit

Más habilidades no significa más fuerte si las habilidades **compiten entre sí**. Estas son las
reglas que sigue cada personaje:

1. **Presupuesto de barra**: **6 habilidades activas + duraluminio** (el autoataque y la mente
   de metal innata van aparte). Lo que no cabe se convierte en **talento**, que modifica una
   habilidad existente.
2. **Coste de oportunidad dentro del turno.** Solo hay 1 Acción y 1 Acción adicional, así que
   las habilidades de un mismo tipo de acción compiten. Ningún personaje puede usar todo su kit
   en un turno.
3. **Las habilidades compiten por la Reserva.** El kit completo de un turno fuerte cuesta más de
   lo que hay en la Reserva. Ejemplo del Deslizador: Burbuja (3) + Avivar peltre (2) + Deslizar
   (1) = 6 de unas 9. Puede hacerlo, pero el turno siguiente casi seguro estará **Seco**.
4. **Cada pico de poder tiene su resaca**: Arrastre de peltre, Seco, la vida que pierdes al
   almacenar en la mente de oro, la recuperación de las técnicas.
5. **Las Reacciones también compiten**: la Guardia y la asistencia del Deslizador usan la misma
   Reacción.
6. **Daño por ronda como vara de medir.** Se compara el **daño medio por ronda** de cada
   personaje en dos situaciones: **sostenido** (sin gastar metal) y **pico** (el mejor turno con
   la Reserva llena). La idea es que los cuatro tengan un daño sostenido parecido; el pico puede
   variar mucho, pero cuanto más alto sea, más preparación o más resaca tiene que costar.

| Nivel 1 (orientativo) | Sostenido | Pico | Qué le cuesta el pico |
|---|---|---|---|
| Lanzamonedas | 11–13 | ~30 (Bala empujada sobre una fila) | Que los enemigos estén alineados |
| Deslizador | 12–14 (con Ritmo) | ~35 (2 Acciones en la burbuja) | Burbuja + Avivar peltre → Seco y Arrastre después |
| Voz | 6–8 | — (su pico es el control) | — |
| Artificiera | 9–11 | ~25 (carga de ettmetal + detonación) | Cargas por combate |

La Voz tiene poco daño a propósito: su valor está en **cuánto daño evita** y en **cuánto daño
extra consiguen los demás** (Encender, Provocar). Se mide así, no con su daño propio.

### 10.1 El Lanzamonedas — *Acero, hierro y estaño*
**Fantasía**: el pistolero volador. Siempre en terreno alto, convierte el escenario en balas.
**Bucle**: reposicionarse con el salto → **marcar** a la presa → buscar el ángulo → empujar o
disparar. El **estaño** encaja con el tirador: sentidos afilados para ver el punto débil de
lejos. Es la "marca del cazador" clásica del arquero de los RPG.

| Habilidad | Coste | Efecto |
|---|---|---|
| *Autoataque: revólver* | — | Distancia larga |
| *Vista de estaño (pasiva)* | — | Ignora el límite de apuntado dentro de la bruma y ve a los enemigos ocultos en su línea de visión |
| **Salto de acero** | Adicional, 1 | Salto de `6 + POT` m (empujas una moneda contra el suelo). No gasta movimiento. Desde arriba: +1 canica de crítico |
| **Empuje** | Acción, 2 | Empuja un prop o enemigo metálico en línea recta. Si el objetivo es Fijo, sales despedido tú (reposicionamiento) |
| **Tirón** | Adicional, 1 | Atrae algo metálico. Un enemigo con armadura metálica llega Derribado; un arma metálica = **Desarme** (el enemigo pasa a un ataque débil) |
| **Bala empujada** | Acción, 3 | Atraviesa a todos los enemigos en línea; +4 de penetración |
| **Marca del cazador** (estaño) | Adicional, 1 | El objetivo queda **Marcado** 2 turnos: el siguiente golpe de **cualquier aliado** hace +50 % e ignora el rango de armadura. Escala POT (duración) |
| **Burbuja de acero** | Reacción, 2 | Hasta tu siguiente turno, **los proyectiles contra ti o aliados a 3 m se desvían**. Determinista (ver nota) |
| **Mente de hierro** *(feruquimia)* | carga | Ligero: saltos ×2 este turno. Pesado: no te pueden empujar, atraer ni derribar |
| **Duraluminio: Meteoro** | todo | Decantas peso en pleno salto y caes encima: área de 4 m, Aturdido. O un empuje de duraluminio que arranca y lanza un prop **Fijo** (una farola) |

> **Nota de coherencia**: en el TODO pusiste "burbuja para % de esquivar balas" y "posibilidad
> de esquivar melee" (estaño). **Las dos rompen tu regla de "aciertas siempre".** Las he
> pasado a **efectos deterministas** (la burbuja desvía los proyectiles; la esquiva es ahora la
> *Guardia* del Deslizador, que esquiva el primer golpe). Así el jugador puede planificar contra ellas.

### 10.2 El Deslizador — *Bendaleo, peltre y oro feruquímico* (el arquetipo de Wayne)
**Fantasía**: el luchador hábil e imprevisible. No gana por fuerza bruta: gana por técnica, por
tiempo y porque no hay manera de tumbarlo. El **bendaleo** le da el *cuándo* (el tiempo), el
**peltre** le da el *cuerpo* (agilidad y aguante, como cuando pelea Vin, no como un bruto) y el
**oro** le da el *aguante a largo plazo*.
**Bucle**: entrar con *Deslizar* → encerrarse con un enemigo (*Burbuja de duelo*) → encadenar
golpes (Ritmo) y proyectarlo → aguantar a base de *Guardia* y *Mente de oro*.

**Recurso propio: Ritmo.** Cada golpe seguido al **mismo objetivo** da 1 punto de Ritmo
(máximo 3, +15 % de daño cada uno). Se pierde si cambias de objetivo, si te Aturden o si pasa un
turno sin golpear.

| Habilidad | Coste | Efecto |
|---|---|---|
| *Autoataque: bastones de duelo* | — | Melee. Escala FUE. Genera Ritmo |
| **Proyección** (peltre) | Acción, 1 | Llave de judo: usas el impulso del enemigo para lanzarlo **en arco** hasta 4 m. Provoca un **IMPACTO** y queda **Derribado**. Es el "lanzar en el ángulo que elijas" del peltre, contado como técnica en vez de fuerza. Escala FUE |
| **Avivar peltre** | Adicional, 2 | 2 turnos: +2 m de movimiento, **inmune a Derribado y Aturdido**, +20 % de daño físico. **Al acabar: Arrastre de peltre** (−50 % de movimiento y de daño durante 1 turno). Es la furia de peltre, pero **sin regeneración**: de curarse ya se encarga el oro |
| **Guardia** (técnica) | Adicional, gratis, recuperación 2 | Hasta tu siguiente turno **esquivas el primer ataque melee** y **contraatacas** al que lo intentó. **Gasta tu Reacción**, así que compite con tu asistencia (*Bateo*). Es el "contraataque instintivo" del estaño, contado como oficio del duelista |
| **Deslizar** (bendaleo) | Adicional, 1 | Una micro burbuja instantánea: te mueves 4 m sin provocar reacciones y puedes acabar a la espalda del enemigo (queda **Desequilibrado**) |
| **Burbuja de duelo** (bendaleo) | Acción, 3 | Burbuja fija de 2,5 m durante 2 turnos. Dentro, el tiempo va **rápido**: **+1 Acción** por turno. Nadie puede disparar a través del borde. Si sales, se rompe. Duración y tamaño escalan con POT |
| **Mente de oro** *(feruquimia innata)* | Adicional | **Almacenar**: pierdes el 20 % de tu vida actual y ganas 1 carga (máximo 3). **Decantar**: te curas `10 + 3·RES` por carga gastada. Si bajas del 25 % de vida, puedes decantar como Reacción |
| **Duraluminio: Mil golpes** | todo | Dentro de una Burbuja de duelo: 4 autoataques seguidos al mismo objetivo, con el Ritmo al máximo |

**Talentos** (modificadores, no ocupan barra): *Pullas* (Guardia también obliga a un enemigo a
6 m a atacarte), *Finta* (el primer golpe tras Deslizar hace siempre el máximo), *Arrollar*
(Deslizar deja Derribado al primer enemigo del recorrido: es el antiguo Placaje), *Peltre
templado* (el Arrastre solo reduce el daño, no el movimiento).

**Por qué esto no le cambia la identidad:** todo lo que se ha añadido sirve a **su mismo
bucle** (pegarse a un enemigo y desmontarlo). La Proyección es un movimiento de duelista y la
Guardia es un *parry*. Ninguna de las dos le convierte en un tanque bruto ni en alguien que
ataca a distancia.

### 10.3 La Voz — *Cinc, latón, bronce y cobre*
**Fantasía**: el titiritero emocional. Decide quién pega a quién.
**Bucle**: leer intenciones → redirigir (Encender/Aplacar) → potenciar a los aliados.

| Habilidad | Coste | Efecto |
|---|---|---|
| *Autoataque: bastón-estoque o pistola ligera* | — | Distancia media |
| **Leer intenciones** (bronce) | Adicional, 1 | Revela la próxima acción de 1 enemigo (o de todos en 6 m si se aviva). Como el *telegraphing* de Into the Breach: convierte la incertidumbre en un puzle |
| **Encender: Provocar** (cinc) | Acción, 2 | Enemigo Enfurecido: ataca al objetivo que tú elijas (normalmente el Deslizador, con la Mente de oro cargada) |
| **Encender: Arenga** (cinc) | Adicional, 1 | Un aliado gana +2 m de movimiento y +20 % de daño este turno |
| **Aplacar** (latón) | Acción, 2 | En un enemigo: Aplacado y pierde sus buffs. En un aliado: le quita los estados negativos |
| **Calma** (latón) | Acción, 3 | El enemigo no es hostil durante 1 turno (se rompe si le haces daño) |
| **Nube de cobre** | Acción, 2 | Zona de 4 m durante 3 turnos: los aliados dentro son inmunes a efectos emocionales y no se les puede leer con bronce. Fuera del combate: sigilo |
| **Duraluminio: Oleada** | todo | En los libros, duraluminio + latón es como Vin paró a los koloss. Aplica Enfurecido o Aplacado a **todos los enemigos en 8 m** |

### 10.4 La Artificiera — *ettmetal, cadmio y feruquimia espiritual*
**Fantasía**: la científica de la Era 2. No es la más fuerte, pero rediseña el campo de batalla.
**Bucle**: preparar el terreno (burbujas, zonas, cargas) → que los demás lo aprovechen.

| Habilidad | Coste | Efecto |
|---|---|---|
| *Autoataque: escopeta o ballesta* | — | Distancia media. **Munición cambiable** (Adicional): normal / **aluminio** (no se puede empujar: atraviesa burbujas de acero enemigas) / **dardo de cromo** (deja Seco al objetivo, 2 por combate) |
| **Granada de cadmio** | Acción, carga | Burbuja de 3 m durante 2 turnos: dentro, el tiempo va **lento**: movimiento ×0,5 y actúan los últimos de la ronda. **Los proyectiles que cruzan el borde se desvían** (pasa en los libros) |
| **Pulso de ettmetal** | Acción, carga | Empuje radial desde un punto: todo lo metálico en 4 m sale despedido hacia fuera |
| **Carga de ettmetal** | Adicional, 1 | Pegas una carga a un prop: cuando ese prop sufre un IMPACTO, explota (Directo, 3 m). **En el agua, el ettmetal reacciona de forma violenta** (lore): combina con la superficie de agua |
| **Liberar mente espiritual** | Acción, 3 | Crea una zona de Fortuna, Conexión o Investidura (§8). Una activa a la vez, 3 turnos |
| **Inyector de oro** | Adicional, carga | Cura a un aliado adyacente 12 + Potencia. Es una mente de oro no sellada: la principal curación de la party |
| **Duraluminio: Decantación total** | todo | La zona activa duplica su radio y combina dos aspectos a la vez |

> **Las cargas de la Artificiera** (granadas, inyector, cubos) son **por combate**, no de la
> Reserva. Así su recurso es distinto del de los demás y su Seco duele menos. Eso compensa que
> sea la más compleja.

---

## 11. El duraluminio compartido

Tu diseño: "la siguiente habilidad hace el doble, pero te agota todo el maná".

> ⚠️ **Problema**: tal cual, lo óptimo es usarlo **con la Reserva casi vacía**, porque no
> pierdes nada. El duraluminio dejaría de ser un sacrificio y pasaría a ser "la habilidad
> gratis de cuando vas a quedarte Seco de todos modos".

**Solución**: que el multiplicador **dependa de lo que quemas**:
```
Multiplicador = 1 + (Reserva consumida / Reserva máxima)
```
Con la Reserva llena es ×2; con media, ×1,5. Ahora sí es una decisión de verdad: ¿quemo diez
puntos ahora para un golpe enorme y me quedo Seco el turno que viene?

Además, en lugar de "doble de lo mismo", **cada personaje tiene su variante de duraluminio**
(ya están en las tablas de arriba). Siguen la misma regla, pero cada uno tiene su fantasía:
los libros ya lo hacen así (duraluminio + acero = empuje imparable; duraluminio + cinc o
latón = control de multitudes).

---

## 12. Fuera del combate

### Principio: los mismos verbos en otro contexto
Los mejores juegos de este género (BG3, Dishonored, Divinity) **reutilizan los poderes del
combate para explorar**. No hacen falta "habilidades de exploración" aparte: cada personaje
tiene **una lente** para mirar el mundo.

| Personaje | Exploración | Social |
|---|---|---|
| **Lanzamonedas** | **Estaño**: oír tras las paredes, ver en la bruma, oler la pólvora (trampas). **Líneas azules**: modo de visión que resalta todo el metal (compartimentos ocultos, mecanismos, trampas metálicas, llaves). Saltar a zonas altas. Atraer palancas o llaves lejanas. Puzles de contrapeso con la mente de hierro | Intimidar con exhibiciones (empujar una moneda contra la pared, al lado de la cabeza) |
| **Deslizador** | **Deslizar**: una burbuja de bendaleo para pasar una patrulla o una trampa en un instante. **Peltre**: forzar puertas, mover escombros. **Oro**: aguanta caídas, venenos y peleas de taberna | **Disfraces y acentos** (como Wayne): suplantar, infiltrarse, improvisar mentiras |
| **Voz** | **Bronce**: detectar alomantes que se esconden (pulsos). **Cobre**: ocultar a la party de los buscadores enemigos | **Aplacar o Encender en los diálogos**: abrir opciones nuevas, calmar a un guardia, provocar una pelea de distracción |
| **Artificiera** | **Cerraduras y trampas mecánicas**. Volar muros con ettmetal. Fabricar viales y cargas. **Cobre feruquímico**: recordar documentos, mapas y pistas (el "diario perfecto") | Conocimiento técnico (convencer a ingenieros, eruditos) |

### Pruebas sin dados (coherente con "aciertas siempre")
En vez de tirar 1d20 (y que el jugador guarde y recargue partida hasta que salga, el gran
problema de BG3):
- Cada prueba tiene una **dificultad visible**, por ejemplo *Agudeza 5*.
- Si tu atributo llega → **pasas gratis**.
- Si no llega → puedes **pagar 1 vial por cada punto que te falte** (avivas el metal para
  compensar), o buscar otra solución (otro personaje, otra ruta).

Así las pruebas pasan de ser apuestas a **decisiones de recursos**, y los viales tienen valor
fuera del combate. Los **viales** son el recurso de exploración: se encuentran, se compran y la
Artificiera los fabrica.

### La bruma
Ya tienes la bruma volumétrica renderizada; aprovéchala en el gameplay:
- Fuera del combate: de noche, la bruma limita la visión (sigilo). El estaño ve a través.
- En combate: **dentro de la bruma no se puede apuntar más allá de `6 + AGU` m** (la Vista de estaño del
  Lanzamonedas y la mente de estaño quitan el límite). Es una alternativa a la cobertura que no necesita % de acierto.

---

## 13. Enemigos: cada herramienta necesita su contrajuego

Un principio de diseño: **por cada verbo fuerte del jugador, tiene que haber un enemigo que lo
complique**. Si no, el jugador encuentra una estrategia dominante y la repite siempre.

| Enemigo | Lo que complica | Cómo se le gana |
|---|---|---|
| Guardia con placas | Al Deslizador (mucha armadura) | Finta del Deslizador, Tirón del Lanzamonedas → Derribado |
| Guardia con aluminio | Al Lanzamonedas (no se puede empujar) | Deslizador, críticos, penetración |
| Koloss | Los empujes (es Gigante) | Aplacar o Encender (son muy emocionales en los libros), terreno, ettmetal |
| Lanzamonedas enemigo | A la party si lleva metal | Burbuja de acero, munición de aluminio, dardo de cromo |
| Aplacador enemigo | La Reacción de tu party | Nube de cobre |
| Ahumador (cobre) | La lectura de intenciones de la Voz | Entrar a melee (Deslizar) |
| Inquisidor de Acero | Todo: es el jefe de élite | Combo de cadena completo + cromo |
| Kandra | La información (se disfraza) | Bronce y Agudeza para detectarla |

---

## 14. Progresión (esbozo)

- **Presupuesto de barra de acceso rápido**: 6 habilidades activas + duraluminio (§10.0). Más que eso satura (lo que tenías en el TODO daba para unas 12 por personaje).
- **Progresión por modificadores, no por habilidades nuevas.** Al subir de nivel se eligen
  **mejoras de habilidades existentes** (por ejemplo, *Empuje: atraviesa al primer objetivo*,
  *Burbuja de duelo: dura un turno más*). La profundidad crece sin que el
  vocabulario crezca.
- Atributos: 2 puntos por nivel con coste creciente (§3). Sin multiclase; los personajes son predefinidos.
- Los hitos de nivel son los que dan **acciones extra** (la Reacción ×2 del Deslizador al nivel
  X, una segunda carga de duraluminio…), nunca una estadística continua (§1).

---

## 15. Orden de prototipado sugerido (sobre lo que ya hay en el motor)

1. **Reserva + Seco + coste de metal** en `skills.json` (nuevo campo `metal: n`).
2. **Empujes y props**: etiqueta *metálico* y tamaño (Pequeño/Grande/Fijo) en los props → Empuje,
   Tirón y Salto con distancia según POT.
3. **Fórmula de armadura** y crítico que ignora la armadura (sobre la bolsa de canicas).
4. **Reacción + 5 disparadores + previsualización de la cadena.** Este es el sistema
   arriesgado: hay que probarlo pronto (*find the fun*).
5. Lanzamonedas + Deslizador completos (empujes, props, burbujas y asistencias).
6. Voz (estados emocionales sobre la IA táctica existente).
7. Artificiera, burbujas temporales y zonas.
8. Feruquimia equipable.

Escenario de prueba ideal: **1 Lanzamonedas + 1 Deslizador contra 4 guardias (2 con placas y 1 con
aluminio) en un patio con cajas, una farola y un charco**. Si ese combate es divertido con dos
personajes, el sistema funciona.

---

## 16. Decisiones tomadas

- **Iniciativa individual**: `2·REF + 1d4`.
- **La Reserva empieza llena** en cada combate. El desgaste entre combates va con los viales.
- **Caído y reanimable** en combate, como en BG3.
- **Sin regla de la masa**: solo "metálico o no" y el tamaño de los props (§5).
- **Seis atributos libres** con coste creciente y dos builds por personaje (§3).
- **El Deslizador (arquetipo de Wayne) sustituye al Violento.** Se queda el peltre (Proyección,
  Avivar peltre) y la Guardia (el contraataque del estaño). La **Marca del cazador** y la vista
  de estaño pasan al Lanzamonedas. La Artificiera se queda con el cadmio, como Marasi.

## 17. Preguntas abiertas [DECIDIR]

1. **Justificación narrativa de los personajes con varios metales alománticos** (la Voz con 4,
   el Deslizador con bendaleo y peltre, el Lanzamonedas con acero, hierro y estaño). Opciones: Nacidos de la Bruma que solo
   dominan parte de los metales, clavos hemalúrgicos (con su coste narrativo de Ruina) o
   medallones de la Era 2.
2. **Nombres e historias de los 4 personajes.** Cuando los tengas, sus arcos personales pueden
   desbloquear su versión de duraluminio, que funciona como la "ultimate" narrativa.
