# Roadmap de producción — Immersive Sim en primera persona

**Motor:** WebGPU + TypeScript  
**Género:** Immersive Sim FPS (dark fantasy)  
**Scope:** 1 nivel completo, jugable de punta a punta

---

## Fase 0 — Pre-producción (~2 semanas)

### Diseño y planificación

**GDD mínimo**  
Core loop, objetivo del nivel, 3 verbos del jugador (moverse, interactuar, atacar). No más de 2 páginas.  
`diseño`

**Mood board visual**  
Referencias de atmósfera: iluminación, paleta de colores, tipo de entorno. Orienta todas las decisiones artísticas.  
`arte`

**Feature list del motor**  
Listar qué sistemas necesita el juego vs qué tiene ya el motor. Priorizar el delta.  
`motor`

**Arquitectura de nivel**  
Sketch en papel: 3 zonas (exterior → transición → interior), flujo del jugador, puntos de interés.  
`diseño`

> 🏁 **Milestone:** GDD firmado + feature list del motor acordado

---

## Fase 1 — Alpha: mecánicas core (~6-8 semanas)

### Bloque 1 · movimiento y física del jugador

**Character controller FPS**  
Rapier KCC, movimiento + salto + crouch. Resolver el bug del dash-through-collider con sensor workaround.  
`motor`

**Cámara FPS**  
Pitch/yaw, FOV configurable, mouse sensitivity, interpolación suave. Head bobbing opcional.  
`motor`

**Sistema de interacción**  
Raycast en crosshair, interfaz IInteractable, highlight de objetos, prompt de UI diegético.  
`motor`

**Objetos físicos interactivos**  
Pick up, throw, use. Cajas, palancas, puertas. Ejercita Rapier rigid bodies + constraints.  
`diseño`

### Bloque 2 · combate básico

**Arma melee**  
Hitbox sweep en arco, damage + knockback. Primero porque no necesita sistema de proyectiles.  
`motor`

**Arma de fuego (hitscan)**  
Raycast, decals de impacto, tracer VFX como cosmético. Fuerza el sistema de partículas/trails.  
`motor`

**Sistema de salud + muerte**  
HP del jugador y enemigos, daño, muerte, respawn o game over. HealthComponent reutilizable.  
`diseño`

**Feedback de impacto**  
Screen shake, hit flash en material, partículas de sangre/chispas. Esencial para game feel.  
`motor`

### Bloque 3 · IA enemiga básica

**Behavior tree base**  
Idle → patrulla → alerta → combate → muerto. Sin animaciones: enemigos como cápsulas con billboard.  
`motor`

**NavMesh + pathfinding**  
recast-navigation-js en runtime. Agentes navegando el blockout, obstacle avoidance básico.  
`motor`

**Sistema de percepción**  
Line of sight con raycast, rango de audición. Fuerza queries de física útiles para el motor.  
`motor`

**Tipo enemigo 1: patrullero**  
Patrulla waypoints, detecta al jugador, ataca cuerpo a cuerpo, alerta a vecinos.  
`diseño`

> 🏁 **Alpha milestone:** loop jugable — puedes entrar, luchar con 1 tipo de enemigo y salir

---

## Fase 2 — Alpha: mundo y sistemas (~5-6 semanas)

### Bloque 4 · blockout del nivel

**Blockout exterior**  
Geometría gris, escala correcta, iluminación direccional. Solo primitivas, sin assets finales.  
`diseño`

**Zona de transición**  
Ruinas, entrada al interior. Prueba el sistema de mixed interior/exterior y froxel fog.  
`diseño`

**Interior completo**  
Pasillos, habitaciones, verticalidad.  
`diseño`

**NavMesh del nivel completo**  
Generar navmesh de las 3 zonas. Verificar que los agentes navegan correctamente inter-zonas.  
`motor`

### Bloque 5 · sistemas de juego

**Estado del mundo**  
Puertas abiertas, switches activados, enemigos muertos. Serialización para que el nivel recuerde cambios.  
`motor`

**Inventario mínimo**  
Armas + consumibles (poción, llave). UI funcional no diegética primero, refinable más tarde.  
`diseño`

**Sistema de sigilo**  
Luz dinámica afecta visibilidad. Apagar antorchas. Agachar reduce ruido. Indicador de alerta.  
`diseño`

**2 enemigos adicionales**  
Tipo 2: arquero/ranged. Tipo 3: tanque lento. Reutiliza BT base, ejercita variedad de IA.  
`diseño`

### Bloque 6 · rendering — features del motor

**Decals de impacto**  
Marcas de bala, sangre en paredes. Decal renderer en deferred. Limpieza por tiempo/count.  
`motor`

**Partículas y trails**  
Tracers de bala, chispas, humo. GPU instancing. Ejercita el particle system del motor.  
`motor`

**Audio espacial 3D**  
Web Audio API, HRTF panning, reverb por zona. Pasos, disparos, alertas. Feature nueva del motor.  
`audio`

> 🏁 **Alpha completa:** nivel jugable de punta a punta, 3 tipos de enemigos, sigilo funcional

---

## Fase 3 — Beta: contenido y polish (~4-5 semanas)

### Bloque 7 · arte y assets

**Meshes del entorno**  
Reemplazar blockout con assets finales. Piedra, madera, metal. Gaea heightmaps para exterior.  
`arte`

**Iluminación de producción**  
Antorchas, candelabros, grietas con luz exterior. Afinar RC GI con geometría final.  
`arte`

**Meshes de enemigos**  
Modelos low-poly dark fantasy. Sin animaciones de esqueleto — locomotion por procedural animation.  
`arte`

**Armas y props**  
Viewmodel de arma en primera persona, props interactivos (cajas, llaves, pociones) con materiales PBR.  
`arte`

### Bloque 8 · animación procedural y VFX

**Procedural animation**  
Locomotion con IK para enemigos. Breathing idle en viewmodel. Sine/cosine bone transforms.  
`motor`

**Weapon sway + recoil**  
Sway por movimiento de cámara, recoil pattern, muzzle flash. Feedback visual de disparo.  
`motor`

**Death ragdoll**  
Ragdoll físico al morir. Ejercita Rapier joints + rigid bodies encadenados.  
`motor`

**Post-process stack**  
LUT color grading dark fantasy, vignette, chromatic aberration al recibir daño.  
`motor`

### Bloque 9 · UI y UX

**HUD final**  
HP, inventario, indicador de sigilo (sombra/luz). JSON-driven UI system. Mínimo, dark fantasy.  
`diseño`

**Menú principal + pausa**  
Menú de inicio, pausa con opciones (audio, gráficos, sensibilidad). Guardado/carga de estado.  
`diseño`

> 🏁 **Beta milestone:** juego con assets finales, sin placeholders, todos los sistemas integrados

---

## Fase 4 — Gold: polish y release (~3 semanas)

### Bloque 10 · optimización y QA

**Performance pass**  
GPU profiling en WebGPU. Occlusion culling, LODs si necesario. Target 60fps en hardware mid-range.  
`motor`

**FSR upscaling**  
EASU + RCAS passes ya evaluados. Activar como opción de calidad para hardware más débil.  
`motor`

**Bug fixing**  
Playtest completo del nivel. Lista de bugs críticos/mayores/menores. Solo fix de críticos y mayores para gold.  
`diseño`

**Audio final y música**  
SFX finales (no placeholders), música ambiental, stingers de combate y sigilo.  
`audio`

### Bloque 11 · game feel final

**Juiciness pass**  
Revisar cada acción: ¿tiene sonido, VFX y feedback visual? Impacto de melee, muerte de enemigo, recoger ítem.  
`diseño`

**Difficulty tuning**  
HP, daño, rangos de percepción de enemigos. Una sesión de playtest externo si es posible.  
`diseño`

**Pantalla de victoria/derrota**  
Objetivo completado → créditos. Muerte → menú con opción de reintentar. Cierre del loop.  
`diseño`

**Build de release**  
Bundle optimizado, asset compression, deploy en hosting estático (GitHub Pages, Netlify, itch.io).  
`motor`

> 🏁 **Gold:** nivel completo, jugable de punta a punta, publicable

---

## Resumen de fases

| Fase                | Duración estimada  | Hito                        |
| ------------------- | ------------------ | --------------------------- |
| 0 — Pre-producción  | ~2 semanas         | GDD + feature list firmados |
| 1 — Alpha mecánicas | ~6-8 semanas       | Loop básico jugable         |
| 2 — Alpha mundo     | ~5-6 semanas       | Nivel completo con sistemas |
| 3 — Beta            | ~4-5 semanas       | Assets finales integrados   |
| 4 — Gold            | ~3 semanas         | Release                     |
| **Total**           | **~20-24 semanas** |                             |

## Features del motor que ejercita este proyecto

| Fase    | Features nuevas forzadas                                           |
| ------- | ------------------------------------------------------------------ |
| Alpha 1 | Física de personaje, decals, trails/partículas, perception queries |
| Alpha 2 | RC GI (4 cascades), serialización de estado, audio espacial 3D     |
| Beta    | Procedural animation + IK, ragdoll físico, post-process LUT        |
| Gold    | FSR upscaling (EASU + RCAS), asset pipeline, GPU profiling         |
