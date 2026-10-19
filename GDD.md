# GDD — Combate táctico Mistborn (Era 1 + Era 2)

> Documento de diseño que parte de [TODO.md](TODO.md). Las decisiones vienen razonadas con la
> teoría que usamos en diseño (MDA, leyes de Sanderson, economía de acciones, enabler/payoff,
> aleatoriedad de entrada vs. salida, _progressive disclosure_…). Lo que está marcado como
> **[DECIDIR]** es una elección tuya; lo demás es mi recomendación.

---

## 0. Pilares de diseño

Los pilares son el filtro de cada decisión: si una mecánica no sirve a al menos uno, se corta.

1. **El metal es el recurso.** Cada habilidad tiene un coste y quedarse seco duele. Es la
   tensión central de riesgo/recompensa (_push your luck_): ¿lo quemo todo ahora o aguanto?
2. **El escenario es un arma.** Cajas, farolas, verjas, cadenas: todo lo metálico o pesado es
   munición. Diseño sistémico: unas pocas reglas físicas → muchas situaciones emergentes.
3. **La party es un instrumento.** Cuatro personajes juntos valen más que la suma. Cada uno
   _prepara_ (enabler) lo que otro _remata_ (payoff).
4. **Magia dura, reglas legibles.** La alomancia de Sanderson es un sistema "duro": el jugador
   tiene que poder predecir qué va a pasar antes de pulsar el botón.

### Las leyes de Sanderson aplicadas al diseño

Sanderson las escribió para novelas, pero valen tal cual para diseño de juegos:

| Ley                                                                                                   | En el libro                                                     | En el juego                                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1ª: la capacidad de resolver conflictos con magia es proporcional a lo bien que el lector la entiende | Por eso Vin gana con empujes que entendemos                     | **Todo se previsualiza**: rango de daño, trayectoria del empuje, qué aliados reaccionan   |
| 2ª: las limitaciones son más interesantes que los poderes                                             | Solo se puede empujar metal, y el metal hay que quemarlo        | **El coste del metal y "solo lo metálico"** son lo que crea decisiones, no el poder en sí |
| 3ª: amplía lo que tienes antes de añadir algo nuevo                                                   | Duraluminio, metales temporales... ¡todo usa las mismas reglas! | Las zonas de Fortuna/Conexión/Investidura **reutilizan sistemas que ya existen** (ver §8) |

### Estéticas objetivo (MDA)

De las 8 estéticas de Hunicke/LeBlanc/Zubek, buscamos: **Desafío** (combate táctico),
**Fantasía** (sentirse como Vin o Wax), **Compañerismo** (sinergia de la party, aunque sea
para un solo jugador) y **Expresión** (varias soluciones para cada combate). Si una mecánica
no apoya ninguna de estas cuatro, sobra.

---

## 1. Economía de acciones

Partimos de lo que ya tiene el motor (estilo BG3) y añadimos la Reacción:

| Recurso              | Por turno               | Para qué sirve                                     |
| -------------------- | ----------------------- | -------------------------------------------------- |
| **Movimiento**       | metros (según Reflejos) | Desplazarse. El salto de acero NO gasta movimiento |
| **Acción**           | 1                       | Ataques, habilidades principales                   |
| **Acción adicional** | 1                       | Habilidades menores, beber vial, cambiar munición  |
| **Reacción**         | 1 por **ronda**         | Asistencias/combos y la Guardia del Deslizador     |
| **Reserva de metal** | barra (ver §2)          | Coste de toda la alomancia                         |

> ⚠️ **Lo de "número de acciones por turno" NO debería ser una estadística que suba de forma
> continua.** La economía de acciones es la palanca más fuerte de un juego por turnos: una
> acción extra equivale a +100 % de daño. En BG3, "Ataque extra" es un hito de nivel, no un
> número que se va subiendo. Recomiendo que las acciones extra vengan solo de **efectos
> concretos y limitados**: burbuja de bendaleo, mente de acero (velocidad), la reacción de la
> Voz al hacer una baja. Así las acciones extra son _momentos_, no la base.

---

## 2. La Reserva de metal y el estado "Seco"

### Tu idea, con dos ajustes

- Cada personaje tiene una **Reserva** con números pequeños (≈ 8–12 puntos). Que no sea de
  100: los enteros pequeños se leen de un vistazo (menos carga cognitiva) y cada punto pesa.
- Las habilidades cuestan **1–4**. El autoataque y las acciones físicas (saltar, las
  técnicas de peltre del Deslizador) no gastan metal.
- **Al llegar a 0 → Seco.** En tu siguiente turno no puedes usar alomancia (te estás bebiendo
  el vial). **Al terminar ese turno, la Reserva se llena entera.**
- **Recarga voluntaria:** con una Acción adicional te declaras Seco por tu cuenta (recargas al
  final del turno siguiente). Es como recargar en XCOM: tú eliges cuándo pagar el coste.
  -------------------------------SI RECARGAR ES CON ADICIONAL EL PERSONAJE PUEDE CADA TURNO USARLA PARA ELLO Y NUNCA QUEDARSE SIN RESERVA NO???

**Ajuste 1 — Que estar Seco nunca sea un turno muerto.** Regla de oro del diseño por turnos:
_nunca le quites el turno al jugador_. Estando Seco **sí puedes** moverte, usar el autoataque,
empujar props a mano, usar objetos, **mentes de metal (feruquimia)** y **asistencias físicas**.
Lo único que pierdes es la alomancia. Así ese turno sigue teniendo decisiones, pero distintas
(y le da valor a los props y la feruquimia, que es justo lo que queremos).

**~~Ajuste 2 — Avivar (flare).~~ Descartado.** Pagar +50 % del coste por +50 % de efecto
hacía lo mismo que el duraluminio (§11) en pequeño, y en la práctica lo sustituía: el
duraluminio dejaba de ser una decisión. Nos quedamos solo con el duraluminio. Si jugando sobra
metal en la Reserva, se puede recuperar como opción al lanzar (sin gastar acción), nunca como
acción adicional.

### Ritmo que sale de esto

`Quemar → Quemar → (Duraluminio) → Seco (turno físico) → Reserva llena → …`
Es un ciclo de tensión y alivio. Un combate dura unas 4–6 rondas, así que cada personaje
pasará por Seco 1 o 2 veces: suficiente para que sea una decisión, no un castigo constante.

### Seco también es un estado que se puede aplicar

El **cromo** (alomancia de cromo: borrar los metales de otro) aplica _Seco_ a un enemigo
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

| Par           | Intensidad                | Aguante                      |
| ------------- | ------------------------- | ---------------------------- |
| **Cuerpo**    | **Fuerza** (FUE)          | **Resistencia** (RES)        |
| **Alomancia** | **Potencia** (POT)        | **Temple** (TEM)             |
| **Instinto**  | **Reflejos** (REF): tempo | **Agudeza** (AGU): precisión |

| Atributo        | En combate                                                                                           | Fuera del combate                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Fuerza**      | Daño físico (melee **y** a distancia: armas, autoataque, técnicas de bastón)                         | Forzar, romper, levantar                                                            |
| **Resistencia** | Vida y curación recibida                                                                             | Aguantar venenos, frío, ceniza, caídas                                              |
| **Potencia**    | Daño de las habilidades alománticas, **distancia** de empuje, tirón y salto, **tamaño** de las áreas | Leer metales, alcance de los pulsos de bronce, influencia emocional en los diálogos |
| **Temple**      | **Reserva máxima**                                                                                   | Resistir interrogatorios, mentiras, alomancia emocional en los diálogos             |
| **Reflejos**    | Movimiento, iniciativa, daño de asistencia                                                           | Sigilo, acrobacias, robar                                                           |
| **Agudeza**     | % de crítico, penetración de armadura, **percepción en combate**                                     | Trampas, cerraduras, pistas                                                         |

**Sobre tu propuesta de un atributo para toda la magia:** estoy de acuerdo con que Potencia
mejore _lo que hace_ una habilidad (daño, distancia y tamaño del área), porque es lo que hace el
"poder mágico" en cualquier RPG y se entiende enseguida. **La duración no**: alargar el control
(Aturdido, Miedo, Enfurecido) es la palanca más peligrosa de un juego por turnos, porque un
enemigo que no actúa dos turnos seguidos es un enemigo muerto (el problema del _stunlock_). Las
duraciones son **fijas en cada habilidad** (casi todo dura 1 turno) y solo las cambian los
talentos, uno a uno. El problema era sumarle también la
Reserva máxima: entonces Potencia te haría más fuerte **y** te dejaría lanzar más veces. Con la
Reserva en Temple, Potencia es _intensidad_ y Temple es _volumen_. Es la decisión clásica de
golpes fuertes frente a aguante: ¿pocas habilidades enormes o muchas normales?

**Sobre si a Agudeza le faltaba algo:** le añado **percepción en combate**. Sirve para ver a
través de la bruma (alcance de apuntado dentro de la bruma: `6 + AGU` m), detectar enemigos
ocultos y emboscadas, y ver las trampas del campo de batalla. **No** le añadiría daño crítico:
el crítico ya ignora la armadura, así que con daño crítico Agudeza se volvería el mejor atributo
de daño (el típico problema de los ARPG en los que todo el mundo acaba acumulando crítico).

### Estadísticas derivadas (primera versión, para afinar jugando)

| Estadística                  | Fórmula                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Daño físico                  | `arma + FUE`                                                                    |
| Vida                         | `25 + 6·RES + 5·(nivel−1)`                                                      |
| Curación recibida            | `+5 % por punto de RES`                                                         |
| Daño de habilidad alomántica | `base de la habilidad + POT`                                                    |
| Distancia de empuje/tirón    | `3 + POT/2` m                                                                   |
| Distancia del salto de acero | `6 + POT` m                                                                     |
| Reserva máxima               | `6 + TEM`                                                                       |
| Movimiento                   | `6 + REF/2` m                                                                   |
| Iniciativa (individual)      | `2·REF + 1d4`                                                                   |
| Daño de asistencia           | `50 % del autoataque + REF`                                                     |
| % de crítico                 | `5 % · (1 + ⌊AGU/2⌋)`, siempre múltiplo de 5 % (bolsa de 20 canicas como mucho) |
| Penetración                  | `⌊AGU/2⌋`                                                                       |

La **armadura** sale solo del equipo, no de un atributo (ver §9). La otra defensa contra los
disparos es la **cobertura** (§5), que sale de dónde te pones, no de tus números.

### Cada habilidad dice con qué escala

Cada habilidad lleva una etiqueta **Escala: FUE / POT / AGU…**. Un mismo personaje tiene
habilidades que escalan con atributos distintos, y eso es lo que hace posibles las builds:

- Las **técnicas de bastón** y el **peltre** del Deslizador (Proyección, autoataque) escalan con **FUE**; sus
  **burbujas de bendaleo**, con **POT** (tamaño); y su **mente de oro**, con **RES**.
  Un Deslizador puede ser virtuoso del golpe o casi inmortal según dónde ponga los puntos.
- Las de **acero/hierro** y las **emocionales** escalan con **POT**.
- El **autoataque** y las armas escalan con **FUE** (y con AGU para los críticos).
- Los **gadgets** de la Artificiera escalan con **POT** (el ettmetal y las mentes de metal son
  Investidura).

### Coste creciente: especializarse se puede, pero sale caro

| Subir a…        | 2–6 | 7–8 | 9–10 |
| --------------- | --- | --- | ---- |
| Coste por punto | 1   | 2   | 3    |

- Se ganan **2 puntos por nivel**.
- Llevar un atributo de 6 a 10 cuesta 10 puntos. En toda la campaña te da para llevar **uno o
  dos atributos al máximo**, no más.
- Así, **especializarse es posible pero caro**, y repartir es más eficiente. Esto responde a tu
  preocupación por el Lanzamonedas: tener mucha vida (RES), mucha movilidad (REF y POT) **y**
  disparar fuerte (FUE y AGU) son 4 o 5 atributos distintos, y no hay puntos para todo. O es un
  cañón de cristal o es duro, pero no las dos cosas.

### Reparto inicial (24 puntos, mínimo 2)

|                  | FUE | RES | POT | TEM | REF | AGU |
| ---------------- | --- | --- | --- | --- | --- | --- |
| **Lanzamonedas** | 4   | 2   | 6   | 3   | 5   | 4   |
| **Deslizador**   | 4   | 5   | 3   | 3   | 5   | 4   |
| **Voz**          | 2   | 3   | 6   | 6   | 3   | 4   |
| **Artificiera**  | 3   | 3   | 4   | 5   | 4   | 5   |

El reparto inicial **sugiere** un estilo de juego, pero a partir de ahí el jugador decide.

### Dos builds por personaje

Cada personaje tiene un árbol de talentos con **dos ramas**. Son una dirección, no son
exclusivas: puedes coger talentos de las dos. Los talentos son **modificadores de habilidades
que ya tienes** (§14), así que la barra de habilidades no crece.

| Personaje        | Rama A                                                           | Rama B                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lanzamonedas** | **Aviador** (POT, REF): saltos más largos, empujes de props,     | **Artillero** (FUE, AGU): revólver, bala empujada, marca del cazador, críticos y penetración. Talento _Rebote_ (la bala empujada rebota en el metal) |
| **Deslizador**   | **Virtuoso** (REF, AGU, FUE): Ritmo, Finta, Proyección, críticos | **Inmortal** (RES, TEM): mente de oro más potente, Guardia más frecuente, Pullas, burbujas más largas                                                |
| **Voz**          | **Titiritero** (POT, TEM): control de grupos, más objetivos      | **Duelista** (FUE, REF): estoque, réplica a los Enfurecidos, se puede elegir como objetivo de su propio Provocar                                     |
| **Artificiera**  | **Ingeniera** (POT, TEM): burbujas, zonas, recargas más cortas   | **Tiradora** (AGU, FUE): munición especial, escopeta, detonación de asistencia                                                                       |

**Ejemplo, la Voz Duelista:** usa _Provocar_ sobre un grupo eligiéndose a sí misma como objetivo
del ataque. Con el talento _Réplica_, cada enemigo Enfurecido que la ataca recibe un
contraataque con el estoque (escala FUE). Con _Arenga_ sobre sí misma, +20 % de daño. Es un
estilo de juego de duelista que provoca a los enemigos, construido con las mismas habilidades
que la Voz Titiritera usa para controlar.

> **Regla de diseño que hay que vigilar:** cada personaje tiene que tener **al menos dos builds
> viables**. Si una rama no aguanta en los combates de prueba, es una trampa para el jugador
> (una _trap build_) y hay que reforzarla.

---

## 4. Daño, armadura y crítico

### Por qué "aciertas siempre" es buena decisión

En diseño se distingue **aleatoriedad de entrada** (pasa _antes_ de decidir: robar cartas, el
mapa) de **aleatoriedad de salida** (pasa _después_: la tirada para impactar). La de salida
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
| -------- | ----- | ------ | ------ | ---------- |
| 0        | 0 %   | 10     | 20     | 100 %      |
| 3        | 20 %  | 8–10   | 16–20  | 90 %       |
| 5        | 29 %  | 7–10   | 14–20  | 85 %       |
| 8        | 40 %  | 6–10   | 12–20  | 80 %       |
| 12       | 50 %  | 5–10   | 10–20  | 75 %       |
| 20       | 63 %  | 4–10   | 8–20   | 69 %       |

**Por qué esta forma:**

- **Hiperbólica** (la misma familia que la armadura de LoL): rendimientos decrecientes, nunca
  llega a inmunidad y un enemigo acorazado no se vuelve imposible.
- **El máximo no baja nunca**: la armadura no te quita daño "seguro", te quita _certeza_. El
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
- Los **props** son **Pequeños** o **Grandes**. No hay props anclados: lo que no se mueve
  (columnas, paredes, farolas) es escenario estático.

| Tamaño      | Ejemplos                                      | Se mueve con…                                                             | Al golpear deja | ¿Es cobertura? |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------- | --------------- | -------------- |
| **Pequeño** | Cuchillos, clavos, monedas sobre una encimera | Tirón y empuje (munición del hierro y el acero)                           | Solo daño       | No             |
| **Grande**  | Cajas, barriles, carros                       | Empuje y tirón si es metálico, o la fuerza del peltre (Proyección, Bateo) | **Aturdido**    | Sí, si es alto |

- Las unidades **Gigantes** (koloss) no se pueden empujar ni atraer.
- El **salto de acero** es su propia habilidad: `6 + POT` m.

### Impactos

```
Daño de impacto = base del prop (Pequeño 6, Grande 10) + atributo de quien lo lanza
```

El atributo es **POT** si se lanza con alomancia (empuje, tirón) y **FUE** si se lanza con
peltre (Proyección, Bateo). Los personajes no lanzan objetos a mano.

**El Empuje** exige estar **al menos a 3 m** del objetivo (de borde a borde) y se puede
**desviar un poco**: la dirección es "alejándolo de ti", girada como mucho **±20°** hacia donde
apuntes. Al apuntarlo se elige primero el objetivo y después la dirección.

**Los objetos no tienen estados**: una caja golpeada recibe el daño, pero no queda Aturdida.

- Prop **Grande** → **Aturdido** (pierde su próxima Acción).
- Prop **Pequeño** → solo daño.
- Unidad empujada o lanzada → **Derribado**.
- Si una unidad empujada **choca contra un muro**: +50 % de daño. Si choca contra otra unidad,
  las dos reciben daño.
- Todo impacto es el disparador **IMPACTO** (§7).

### Cobertura: tapa o no tapa

El escenario estático y los props Grandes y altos son también **coberturas**. Como aquí se acierta
siempre, la cobertura **no da porcentajes** (ni "media" ni "completa"): **o tapa o no tapa**.
Si tapa, no te pueden apuntar con nada que necesite línea de visión (disparos y habilidades de
un objetivo, estados incluidos).

**Qué es cobertura**: lo que es más alto que una persona agachada: columnas, paredes, esquinas,
cajas apiladas, carros. Lo bajo (un barril, un murete) no cuenta: por encima se dispara.

**Te protege por dirección, no por milímetros.** Si estás **pegado** a una cobertura (a menos de
~1 m), quedas a cubierto de **todo el que esté al otro lado**, dentro de un arco amplio (≈ 140°)
centrado en la cara de la cobertura. No hace falta ponerse en el punto exacto para que un
enemigo no te dé "de refilón": basta con estar detrás de la columna respecto a él. Como no
hay cuadrícula (XCOM la tiene), la regla sale de la **cara** de la cobertura y no del rayo exacto:

- **Al moverte, el destino se ajusta solo (snap)**: si el punto que eliges está cerca de una
  cobertura, la unidad se queda pegada a ella. En el destino se ve un **escudo** por cada
  dirección cubierta y qué enemigos dejarían de verte.
- **Al apuntar**, la vista previa dice "a cubierto" y el objetivo no se puede elegir.
- **Fuera del arco no protege**: si el enemigo está a tu lado de la columna, te ve.

**Qué la anula** (y por eso moverse importa):

- **Flanquear**: ponerse fuera del arco de la cobertura.
- **El cuerpo a cuerpo** y **las áreas** (bola de fuego, granadas): la columna no protege de
  una explosión a tu lado.
- **Mover o romper la cobertura**: un prop Grande es cobertura hasta que el Lanzamonedas lo
  atrae, lo empuja (o lo lanza contra quien se escondía detrás) o alguien lo destruye. El
  escenario es arma y escudo a la vez: el pilar 2 en estado puro.
- **El Rebote** del Lanzamonedas (talento de la Bala empujada): la bala rebota en un objeto
  metálico y alcanza a quien se esconde detrás de una cobertura. Con la cobertura, el Rebote
  pasa de curiosidad a herramienta.
- Lo **empujado en línea recta** choca con la cobertura (IMPACTO contra ella), no contigo.

---

## 6. Estados (vocabulario de combate)

Pocos y bien definidos. Cada palabra nueva es un coste cognitivo, así que son **6**, cada uno
con un papel distinto, y todos se pueden aplicar en ambas direcciones (jugador ↔ enemigo). Los objetos no tienen
estados. Las
duraciones son fijas en cada habilidad (POT no las alarga, §3).

| Estado         | Papel       | Efecto                                                                                          | Lo aplica sobre todo                         |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Aturdido**   | Tempo       | Pierde su próxima Acción                                                                        | Impacto de prop Grande, mente de peltre      |
| **Derribado**  | Física      | Levantarse cuesta la mitad del movimiento; los ataques melee contra él son crítico seguro       | Tirón de hierro, unidad empujada, Proyección |
| **Marcado**    | Preparación | El siguiente golpe que recibe hace +50 % (+30 % + 5 %·POT con la Marca del cazador); se consume | Marca del cazador, Deslizar, Detonación      |
| **Enfurecido** | Control     | Tiene que atacar al objetivo que elijas; +25 % al daño que hace y −3 de armadura                | Encender (cinc)                              |
| **Aplacado**   | Control     | Sin Reacción y −25 % de daño                                                                    | Aplacar (latón)                              |
| **Seco**       | Recurso     | Sin alomancia este turno                                                                        | Quedarse sin Reserva, cromo                  |

> **Simplificado**: _Lanzado_ desaparece (un empuje ya acaba en IMPACTO y Derribado) y
> _Desequilibrado_ se funde con **Marcado**, que pasa a ser la preparación universal. Antes
> eran dos versiones del mismo "el siguiente golpe hace más" (+25 % y +50 %).

---

## 7. Asistencias / combos

### Referentes

Las reacciones de BG3, los combos elementales de Divinity: Original Sin 2, el "One More"
de Persona y el _break_ de Octopath. Lo que tienen en común:
**un disparador legible → una respuesta automática → un tope que evita bucles infinitos**.

### Reglas

1. **Cuatro disparadores**, ni uno más:
   - **IMPACTO**: un prop o una unidad choca contra algo.
   - **DERRIBADO**: se aplica ese estado.
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
   _juice_.
6. **Previsualización**: al apuntar una acción, salen los retratos de los aliados que van a
   reaccionar. Sin esto, los combos son azar. Con esto, son _planificación_ (1ª ley).
7. Interruptor por personaje: **automático / preguntar / nunca** (como las reacciones de BG3),
   para guardar la Reacción por si hace falta para defenderse.

### La asistencia de cada personaje

| Personaje        | Disparador                                    | Asistencia          | Efecto                                                                                              |
| ---------------- | --------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| **Lanzamonedas** | DERRIBADO                                     | _Tiro al plato_     | Disparo con el daño de asistencia al enemigo que cae                                                |
| **Deslizador**   | IMPACTO de un enemigo que **acaba a su lado** | _Bateo_             | Golpe melee que además **redirige** al enemigo 3 m hacia donde tú elijas (provoca un nuevo IMPACTO) |
| **Voz**          | BAJA o CRÍTICO de un aliado                   | _Encender el ánimo_ | Ese aliado gana **1 Acción adicional** inmediata (cuesta 1 de metal)                                |
| **Artificiera**  | IMPACTO                                       | _Detonación_        | Dispara al punto de impacto: daño en área de 2 m y Marcado. Si el prop lleva ettmetal, explota      |

### Ejemplo de cadena (es tu caso de la caja, ampliado)

1. El **Lanzamonedas** empuja una caja metálica Grande contra un guardia → **IMPACTO** (daño,
   Aturdido).
2. → La **Artificiera** reacciona con _Detonación_ en el punto de impacto: el guardia y su
   compañero quedan **Marcados**. (Eslabón 1, ×1,1)
3. → El compañero sale despedido y acaba junto al **Deslizador**, que reacciona con _Bateo_
   (+50 % por la Marca) → **crítico**, y lo devuelve contra la caja (nuevo IMPACTO). (Eslabón 2,
   ×1,2)
4. → La **Voz** reacciona a ese crítico con _Encender_: el Deslizador gana una Acción adicional
   y la usa para _Deslizar_ a la espalda del guardia aturdido. (Eslabón 3, tope)

> Ojo: **nadie reacciona a sus propias acciones**. Por eso el Lanzamonedas, que empezó la
> cadena, no puede hacer _Tiro al plato_ en ella.

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

| Zona            | Efecto                                                                                                    | Sistema que reutiliza            |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Fortuna**     | Quien ataca desde dentro mete +2 canicas de crítico en su bolsa                                           | La bolsa de canicas              |
| **Conexión**    | Un estado aplicado a una unidad que está dentro se copia a todas las de su bando que también estén dentro | Los estados                      |
| **Investidura** | Las habilidades que se usan desde dentro hacen **+50 % de efecto**                                        | El multiplicador del duraluminio |

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
  recarga. Es su identidad.

### ¿Son demasiadas mecánicas? (presupuesto de complejidad)

Cuenta de sistemas: Reserva/Seco, economía de acciones, empujes y props, estados,
asistencias, crítico, feruquimia equipable, duraluminio y zonas. Son 9. BG3 tiene bastantes
más; lo que importa no es el número, sino:

- **Elegancia = profundidad / complejidad.** Las zonas pasan el filtro porque **no añaden
  vocabulario**: hablan de canicas, estados y el multiplicador del duraluminio, que ya existen.
- **_Progressive disclosure_**: no lo enseñes todo a la vez. Orden recomendado:
  1. Acto 1, inicio: autoataque, Reserva/Seco, props.
  2. Acto 1, mitad: asistencias (cuando tengas los 4 personajes).
  3. Acto 1, final: feruquimia equipable y duraluminio.
  4. Acto 2: relicarios del escenario.
  5. Acto 2, mitad: la Artificiera aprende a crear zonas.
- **Orden de recorte** si hay que quitar algo (del primero en caer al último): Investidura → Conexión → Fortuna → mentes de metal → asistencias. Las asistencias y los props
  son el corazón del juego; eso no se toca.

---

## 9. Equipo y feruquimia equipable

### Las mentes de metal como objetos: sí, y tiene base en los libros

En _Brazales del Duelo_ existen las **mentes de metal no selladas**: cualquiera puede usarlas.
Es la justificación perfecta para la personalización.

- **2 ranuras de mente de metal** por personaje (brazal y anillo).
- **Mecánica de los libros = deuda temporal.** La feruquimia es "más débil ahora, más fuerte
  después": la deuda se paga **fuera del combate**, al llenar la mente explorando o en el
  campamento. Cada mente:
  - empieza el combate con **una carga**;
  - **decantar no gasta acción**: gastas la carga y te llevas el beneficio cuando quieras de tu
    turno, así que se combina con el resto (Ligero + Salto de acero);
  - **en combate no se almacena ni se recarga** (decidido, para todas las mentes): una carga
    por combate. La decisión es _cuándo_ usarla.

| Mente                        | Al decantar (beneficio)                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| **Oro** (salud)              | Curación de 6/turno durante 3 turnos                                 |
| **Peltre** (fuerza)          | Siguiente golpe ×2 y Aturdido. _Tu "megaataque"_                     |
| **Acero** (velocidad)        | Movimiento ×2 y +1 Acción adicional. _Tu "megavelocidad"_ (ver nota) |
| **Hierro** (peso)            | Ligero: saltos ×2. Pesado: no te pueden empujar, atraer ni derribar  |
| **Estaño** (sentidos)        | +2 canicas de crítico y ves a través de la bruma                     |
| **Cinc** (velocidad mental)  | Primero en la iniciativa y +1 Reacción                               |
| **Bronce** (vigilia)         | Inmune a Aturdido 2 turnos                                           |
| **Electrum** (determinación) | La próxima vez que caigas a 0, te quedas a 1                         |
| **Cromo** (Fortuna)          | Mini zona de Fortuna personal                                        |
| **Latón** (calor)            | Inmune a las superficies de fuego o hielo                            |
| **Cobre** (memoria)          | Sobre todo fuera del combate (§11)                                   |

> **Corrección de lore**: en el TODO pusiste "electrum feruquímico = megavelocidad". En los
> libros, la velocidad física es el **acero** feruquímico (los "corredores de acero"). El
> electrum guarda **determinación**, que encaja muy bien con "no caer a 0".

### Armadura: la decisión de equipo más Mistborn posible

| Tipo         | Armadura   | Contrapartida                                                     |
| ------------ | ---------- | ----------------------------------------------------------------- |
| Cuero, ropa  | Baja       | Ninguna                                                           |
| Placas, cota | Alta       | **Metal portado**: te pueden empujar, atraer, derribar y desarmar |
| Aluminio     | Media-alta | Inmune al empuje, pero cara y rara                                |

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
**dos distancias** (melee y apoyo a media distancia). Encima usaba el taunt para _protegerse_
a sí mismo, que va en contra de lo que es un berserker. **La solución es partirlo en dos**: el
Deslizador, que _aguanta_ los golpes regenerándose, y la Voz, que _hace_ que le peguen a él. El taunt pasa de
ser autoprotección a ser **sinergia**.

### Resumen

|                 | Lanzamonedas                               | Deslizador                                              | Voz                        | Artificiera                                                        |
| --------------- | ------------------------------------------ | ------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| **Metales**     | Acero, hierro, estaño + hierro feruquímico | Bendaleo, peltre + oro feruquímico, técnica de bastones | Cinc, latón, bronce, cobre | Gadgets de ettmetal, cadmio en dispositivos, feruquimia espiritual |
| **Rol**         | Daño a distancia, movilidad                | Duelista que aguanta regenerándose, primera línea       | Control, apoyo             | Control del terreno, utilidad                                      |
| **Distancia**   | Larga                                      | Cuerpo a cuerpo                                         | Media                      | Media                                                              |
| **Builds** (§3) | Aviador / Artillero                        | Virtuoso / Inmortal                                     | Titiritero / Duelista      | Ingeniera / Tiradora                                               |
| **Complejidad** | ★★☆                                        | ★☆☆ (el más fácil)                                      | ★★☆                        | ★★★                                                                |
| **Referente**   | Wax, Vin                                   | Wayne                                                   | Brisa (Breeze)             | Marasi (Pulsadora, cadmio), Steris                                 |

> Un personaje de complejidad baja (el Lanzamonedas) es importante: es el "personaje de entrada"
> para quien no conoce el sistema, igual que en Overwatch o los MOBA.

### ¿Quién lanza los props?

Tu duda era si darle todos los props al Lanzamonedas. **Mejor que los props sean un lenguaje
compartido**, y que cada personaje los use con una **geometría distinta**:

| Quién        | Cómo               | Geometría                                                                                                                    |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Lanzamonedas | Empuje / tirón     | **Línea recta** alejándose (±20°, a 3 m o más) o acercándose a él. Distancia según POT                                       |
| Deslizador   | Bateo y Proyección | **Redirección y arco**: devuelve lo que le llega 3 m hacia donde elijas, o lanza en arco al enemigo con el que está peleando |
| Artificiera  | Pulso del cubo     | **Radial**: todo lo metálico sale hacia fuera desde un punto                                                                 |
| Voz          | No lanza props     | **Mueve a los enemigos hacia los props** (taunt, Enfurecido)                                                                 |

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
4. **Cada pico de poder tiene su resaca**: Arrastre de peltre, Seco, la única carga de la mente
   de metal, la recuperación de las técnicas.
5. **Las Reacciones también compiten**: la Guardia y la asistencia del Deslizador usan la misma
   Reacción.
6. **Daño por ronda como vara de medir.** Se compara el **daño medio por ronda** de cada
   personaje en dos situaciones: **sostenido** (sin gastar metal) y **pico** (el mejor turno con
   la Reserva llena). La idea es que los cuatro tengan un daño sostenido parecido; el pico puede
   variar mucho, pero cuanto más alto sea, más preparación o más resaca tiene que costar.

| Nivel 1 (orientativo) | Sostenido         | Pico                                 | Qué le cuesta el pico                             |
| --------------------- | ----------------- | ------------------------------------ | ------------------------------------------------- |
| Lanzamonedas          | 11–13             | ~30 (Bala empujada sobre una fila)   | Que los enemigos estén alineados                  |
| Deslizador            | 12–14 (con Ritmo) | ~35 (2 Acciones en la burbuja)       | Burbuja + Avivar peltre → Seco y Arrastre después |
| Voz                   | 6–8               | — (su pico es el control)            | —                                                 |
| Artificiera           | 9–11              | ~25 (carga de ettmetal + detonación) | Cargas por combate                                |

La Voz tiene poco daño a propósito: su valor está en **cuánto daño evita** y en **cuánto daño
extra consiguen los demás** (Encender, Provocar). Se mide así, no con su daño propio.

### 10.1 El Lanzamonedas — _Acero, hierro y estaño_

**Fantasía**: el pistolero volador. Siempre en terreno alto, convierte el escenario en balas.
**Bucle**: reposicionarse con el salto → **marcar** a la presa → buscar el ángulo → empujar o
disparar. El **estaño** encaja con el tirador: sentidos afilados para ver el punto débil de
lejos. Es la "marca del cazador" clásica del arquero de los RPG.

| Habilidad                          | Coste                           | Efecto                                                                                                                                                      |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| _Autoataque: revólver_             | —                               | Distancia larga                                                                                                                                             |
| **Salto de acero**                 | Adicional, 1                    | Salto de `6 + POT` m (empujas una moneda contra el suelo). No gasta movimiento.                                                                             |
| **Empuje**                         | Acción, 2                       | Empuja un prop o enemigo metálico en línea recta, desviable ±20°. Hay que estar al menos a 3 m.                                                             |
| **Tirón**                          | Adicional, 1                    | Atrae algo metálico. Un enemigo con armadura metálica llega Derribado; un arma metálica = **Desarme** (el enemigo pasa a un ataque débil)                   |
| **Bala empujada**                  | Acción, 3                       | Atraviesa a todos los enemigos en línea; +4 de penetración                                                                                                  |
| **Marca del cazador** (estaño)     | Adicional, 1                    | El objetivo queda **Marcado** 2 turnos: el siguiente golpe de **cualquier aliado** hace **+30 % + 5 % por punto de POT** (+60 % con POT 6) y quita la marca |
| **Burbuja de acero**               | Adicional, 2                    | Hasta tu siguiente turno, **los proyectiles contra ti tienen un 50% de fallar**.                                                                            |
| **Mente de hierro** _(feruquimia)_ | Sin acción, 1 carga por combate | Ligero: saltos ×2 este turno. Pesado: no te pueden empujar, atraer ni derribar                                                                              |     |

### 10.2 El Deslizador — _Bendaleo, peltre y oro feruquímico_ (el arquetipo de Wayne)

**Fantasía**: el luchador hábil e imprevisible. No gana por fuerza bruta: gana por técnica, por
tiempo y porque no hay manera de tumbarlo. El **bendaleo** le da el _cuándo_ (el tiempo), el
**peltre** le da el _cuerpo_ (agilidad y aguante, como cuando pelea Vin, no como un bruto) y el
**oro** le da el _aguante a largo plazo_.
**Bucle**: entrar con _Deslizar_ → encerrarse con un enemigo (_Burbuja de duelo_) → encadenar
golpes (Ritmo) y proyectarlo → aguantar a base de _Guardia_ y _Mente de oro_.

**Recurso propio: Ritmo.** Cada golpe seguido al **mismo objetivo** da 1 punto de Ritmo
(máximo 3, +15 % de daño cada uno). Se pierde si cambias de objetivo, si te Aturden o si pasa un
turno sin golpear.

| Habilidad                              | Coste                             | Efecto                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Autoataque: bastones de duelo_        | —                                 | Melee. Escala FUE. Genera Ritmo                                                                                                                                                                                                                             |
| **Proyección** (peltre)                | Acción, 1                         | Llave de judo: usas el impulso del enemigo para lanzarlo **en arco** hasta 4 m. Provoca un **IMPACTO** y queda **Derribado**. Es el "lanzar en el ángulo que elijas" del peltre, contado como técnica en vez de fuerza. Escala FUE                          |
| **Avivar peltre**                      | Adicional, 2                      | 2 turnos: +2 m de movimiento, **inmune a Derribado y Aturdido**, +20 % de daño físico. **Al acabar: Arrastre de peltre** (−50 % de movimiento y de daño durante 1 turno). Es la furia de peltre, pero **sin regeneración**: de curarse ya se encarga el oro |
| **Guardia** (técnica)                  | Adicional, gratis, recuperación 2 | Hasta tu siguiente turno **esquivas el primer ataque melee** y **contraatacas** al que lo intentó. **Gasta tu Reacción**, así que compite con tu asistencia (_Bateo_). Es el "contraataque instintivo" del estaño, contado como oficio del duelista         |
| **Deslizar** (bendaleo)                | Adicional, 1                      | Una micro burbuja instantánea: te mueves 4 m sin provocar reacciones y puedes acabar a la espalda del enemigo (queda **Marcado**)                                                                                                                           |
| **Burbuja de duelo** (bendaleo)        | Acción, 3                         | Burbuja fija de 2,5 m durante 2 turnos. Dentro, el tiempo va **rápido**: **+1 Acción** por turno. Nadie puede disparar a través del borde. Si sales, se rompe. El tamaño escala con POT                                                                     |
| **Mente de oro** _(feruquimia innata)_ | Sin acción, 1 carga por combate   | **Decantar**: te curas `10 + 3·RES`. La carga se llena fuera del combate                                                                                                                                                                                    |

**Talentos** (modificadores, no ocupan barra): _Pullas_ (Guardia también obliga a un enemigo a
6 m a atacarte), _Finta_ (el primer golpe tras Deslizar hace siempre el máximo), _Arrollar_
(Deslizar deja Derribado al primer enemigo del recorrido: es el antiguo Placaje), _Peltre
templado_ (el Arrastre solo reduce el daño, no el movimiento).

**Por qué esto no le cambia la identidad:** todo lo que se ha añadido sirve a **su mismo
bucle** (pegarse a un enemigo y desmontarlo). La Proyección es un movimiento de duelista y la
Guardia es un _parry_. Ninguna de las dos le convierte en un tanque bruto ni en alguien que
ataca a distancia.

### 10.3 La Voz — _Cinc, latón, bronce y cobre_

**Fantasía**: el titiritero emocional. Decide quién pega a quién.
**Bucle**: leer intenciones → redirigir (Encender/Aplacar) → potenciar a los aliados.

| Habilidad                                     | Coste        | Efecto                                                                                                                                          |
| --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| _Autoataque: bastón-estoque o pistola ligera_ | —            | Distancia media                                                                                                                                 |
| **Leer intenciones** (bronce)                 | Adicional, 1 | Revela la próxima acción de 1 enemigo. Como el _telegraphing_ de Into the Breach: convierte la incertidumbre en un puzle                        |
| **Encender: Provocar** (cinc)                 | Acción, 2    | Enemigo Enfurecido: ataca al objetivo que tú elijas (normalmente el Deslizador, con la Mente de oro cargada)                                    |
| **Encender: Arenga** (cinc)                   | Adicional, 1 | Un aliado gana +2 m de movimiento y +20 % de daño este turno                                                                                    |
| **Aplacar** (latón)                           | Acción, 2    | En un enemigo: Aplacado y pierde sus buffs. En un aliado: le quita los estados negativos                                                        |
| **Calma** (latón)                             | Acción, 3    | El enemigo no es hostil durante 1 turno (se rompe si le haces daño)                                                                             |
| **Nube de cobre**                             | Acción, 2    | Zona de 4 m durante 3 turnos: los aliados dentro son inmunes a efectos emocionales y no se les puede leer con bronce. Fuera del combate: sigilo |

### 10.4 La Artificiera — _ettmetal, cadmio y feruquimia espiritual_

**Fantasía**: la científica de la Era 2. No es la más fuerte, pero rediseña el campo de batalla.
**Bucle**: preparar el terreno (burbujas, zonas, cargas) → que los demás lo aprovechen.

| Habilidad                         | Coste                   | Efecto                                                                                                                                                                                                     |
| --------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Autoataque: escopeta o ballesta_ | —                       | Distancia media. **Munición cambiable** (Adicional): normal / **aluminio** (no se puede empujar: atraviesa burbujas de acero enemigas) / **dardo de cromo** (deja Seco al objetivo, 2 de metal, recarga 3) |
| **Granada de cadmio**             | Acción, 3, recarga 3    | Burbuja de 3 m durante 2 turnos: dentro, el tiempo va **lento**: movimiento ×0,5 y actúan los últimos de la ronda. **Los proyectiles que cruzan el borde se desvían** (pasa en los libros)                 |
| **Pulso de ettmetal**             | Acción, 2, recarga 2    | Empuje radial desde un punto: todo lo metálico en 4 m sale despedido hacia fuera                                                                                                                           |
| **Carga de ettmetal**             | Adicional, 1            | Pegas una carga a un prop: cuando ese prop sufre un IMPACTO, explota (Directo, 3 m). **En el agua, el ettmetal reacciona de forma violenta** (lore): combina con la superficie de agua                     |
| **Liberar mente espiritual**      | Acción, 3               | Crea una zona de Fortuna, Conexión o Investidura (§8). Una activa a la vez, 3 turnos                                                                                                                       |
| **Inyector de oro**               | Adicional, 2, recarga 2 | Cura a un aliado adyacente 12 + Potencia. Es una mente de oro no sellada: la principal curación de la party                                                                                                |

> **Los gadgets de la Artificiera** (granadas, pulso, inyector) **no tienen cargas por
> combate**: gastan metal de la Reserva, como todo lo demás, y se limitan con **recarga**, el
> mismo sistema que ya tienen todas las habilidades. Un solo recurso, como los otros tres
> personajes: así no se le suma complejidad a la que ya es la más compleja.

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

**Sin variantes por personaje** (decidido): el duraluminio es igual para todos y solo potencia
la siguiente habilidad alomántica (daño, curación y distancia de empuje, tirón o salto). La
fantasía sale de con qué se combina: un Empuje que lanza la caja el doble de lejos, una Bala
empujada que hace el doble a toda la fila.

---

## 12. Fuera del combate

### Principio: los mismos verbos en otro contexto

Los mejores juegos de este género (BG3, Dishonored, Divinity) **reutilizan los poderes del
combate para explorar**. No hacen falta "habilidades de exploración" aparte: cada personaje
tiene **una lente** para mirar el mundo.

| Personaje        | Exploración                                                                                                                                                                                                                                                                                                    | Social                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Lanzamonedas** | **Estaño**: oír tras las paredes, ver en la bruma, oler la pólvora (trampas). **Líneas azules**: modo de visión que resalta todo el metal (compartimentos ocultos, mecanismos, trampas metálicas, llaves). Saltar a zonas altas. Atraer palancas o llaves lejanas. Puzles de contrapeso con la mente de hierro | Intimidar con exhibiciones (empujar una moneda contra la pared, al lado de la cabeza)                                 |
| **Deslizador**   | **Deslizar**: una burbuja de bendaleo para pasar una patrulla o una trampa en un instante. **Peltre**: forzar puertas, mover escombros. **Oro**: aguanta caídas, venenos y peleas de taberna                                                                                                                   | **Disfraces y acentos** (como Wayne): suplantar, infiltrarse, improvisar mentiras                                     |
| **Voz**          | **Bronce**: detectar alomantes que se esconden (pulsos). **Cobre**: ocultar a la party de los buscadores enemigos                                                                                                                                                                                              | **Aplacar o Encender en los diálogos**: abrir opciones nuevas, calmar a un guardia, provocar una pelea de distracción |
| **Artificiera**  | **Cerraduras y trampas mecánicas**. Volar muros con ettmetal. Fabricar viales y cargas. **Cobre feruquímico**: recordar documentos, mapas y pistas (el "diario perfecto")                                                                                                                                      | Conocimiento técnico (convencer a ingenieros, eruditos)                                                               |

### Pruebas sin dados (coherente con "aciertas siempre")

En vez de tirar 1d20 (y que el jugador guarde y recargue partida hasta que salga, el gran
problema de BG3):

- Cada prueba tiene una **dificultad visible**, por ejemplo _Agudeza 5_.
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
  Lanzamonedas y la mente de estaño quitan el límite). Se suma a la cobertura (§5) y tampoco necesita % de acierto.

---

## 13. Enemigos: cada herramienta necesita su contrajuego

Un principio de diseño: **por cada verbo fuerte del jugador, tiene que haber un enemigo que lo
complique**. Si no, el jugador encuentra una estrategia dominante y la repite siempre.

| Enemigo              | Lo que complica                       | Cómo se le gana                                                           |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Guardia con placas   | Al Deslizador (mucha armadura)        | Finta del Deslizador, Tirón del Lanzamonedas → Derribado                  |
| Guardia con aluminio | Al Lanzamonedas (no se puede empujar) | Deslizador, críticos, penetración                                         |
| Koloss               | Los empujes (es Gigante)              | Aplacar o Encender (son muy emocionales en los libros), terreno, ettmetal |
| Lanzamonedas enemigo | A la party si lleva metal             | Burbuja de acero, munición de aluminio, dardo de cromo                    |
| Aplacador enemigo    | La Reacción de tu party               | Nube de cobre                                                             |
| Ahumador (cobre)     | La lectura de intenciones de la Voz   | Entrar a melee (Deslizar)                                                 |
| Inquisidor de Acero  | Todo: es el jefe de élite             | Combo de cadena completo + cromo                                          |
| Kandra               | La información (se disfraza)          | Bronce y Agudeza para detectarla                                          |

---

## 14. Progresión (esbozo)

- **Presupuesto de barra de acceso rápido**: 6 habilidades activas + duraluminio (§10.0). Más que eso satura (lo que tenías en el TODO daba para unas 12 por personaje).
- **Progresión por modificadores, no por habilidades nuevas.** Al subir de nivel se eligen
  **mejoras de habilidades existentes** (por ejemplo, _Empuje: atraviesa al primer objetivo_,
  _Burbuja de duelo: dura un turno más_). La profundidad crece sin que el
  vocabulario crezca.
- Atributos: 2 puntos por nivel con coste creciente (§3). Sin multiclase; los personajes son predefinidos.
- Los hitos de nivel son los que dan **acciones extra** (la Reacción ×2 del Deslizador al nivel
  X, una segunda carga de duraluminio…), nunca una estadística continua (§1).

---

## 15. Orden de prototipado sugerido (sobre lo que ya hay en el motor)

1. **Reserva + Seco + coste de metal** y **fórmula de armadura** con el crítico que la ignora.
   _(Hecho.)_
2. **La base de la party**: los 4 personajes con sus atributos y autoataques.
3. **Cada personaje con los sistemas que necesita**, siempre genéricos (efectos de datos que
   los demás reutilizan):
   - Lanzamonedas → props, empuje, tirón, desarme, impactos y los estados físicos.
   - Deslizador → Ritmo, Proyección (reutiliza los impactos), peltre y mente de oro.
   - Cobertura, en cuanto hay un tirador y props Grandes.
   - Voz → estados emocionales sobre la IA táctica existente.
   - Zonas genéricas → burbujas, nubes y lo que necesita la Artificiera.
4. **Reacción, 4 disparadores, asistencias y previsualización de la cadena**, cuando ya están
   los cuatro personajes: así se prueban las interacciones que se han diseñado, con todos los
   disparadores, y no unas de prueba.
5. Zonas espirituales y relicarios.
6. Feruquimia equipable.

Escenario de prueba: **los 4 personajes contra un grupo de guardias (con placas y con
aluminio) en un patio con cajas, columnas, cuchillos en una encimera, una farola y un
charco**. Si ese combate es divertido, el sistema funciona.

---

## 16. Decisiones tomadas

- **Iniciativa individual**: `2·REF + 1d4`.
- **La Reserva empieza llena** en cada combate. El desgaste entre combates va con los viales.
- **Caído y reanimable** en combate, como en BG3.
- **Sin regla de la masa**: solo "metálico o no" y el tamaño de los props, Pequeño o Grande (§5).
  **Sin props Fijos**: lo que no se mueve es escenario.
- **Cobertura binaria** (§5): tapa o no tapa, sin porcentajes. Protege por dirección (arco
  de la cara de la cobertura) y el destino se ajusta a ella al moverse. La anulan el flanqueo,
  el melee, las áreas, el Rebote y mover o romper la cobertura.
- **POT no alarga los estados** (§3): duraciones fijas por habilidad. TEM es solo la Reserva.
- **6 estados** (§6): Lanzado y Desequilibrado desaparecen. 4 disparadores de asistencia (§7).
- **La Artificiera sin cargas por combate**: sus gadgets gastan metal y tienen recarga (§10.4).
- **Las zonas** (burbujas, nubes, zonas espirituales) se implementan con la Artificiera, después
  del prototipo de dos personajes.
- **Seis atributos libres** con coste creciente y dos builds por personaje (§3).
- **El Deslizador (arquetipo de Wayne) sustituye al Violento.** Se queda el peltre (Proyección,
  Avivar peltre) y la Guardia (el contraataque del estaño). La **Marca del cazador** y la vista
  de estaño pasan al Lanzamonedas. La Artificiera se queda con el cadmio, como Marasi.

## 17. Preguntas abiertas [DECIDIR]

1. **Justificación narrativa de los personajes con varios metales alománticos** (la Voz con 4,
   el Deslizador con bendaleo y peltre, el Lanzamonedas con acero, hierro y estaño). Opciones: Nacidos de la Bruma que solo
   dominan parte de los metales, clavos hemalúrgicos (con su coste narrativo de Ruina) o
   medallones de la Era 2.
2. **Historias de los 4 personajes.** De nombre se llaman como su clase: Lanzamonedas,
   Deslizador, Voz y Artificiera.
