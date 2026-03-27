### Engine

1. HZB Culling regulero
2. Transparency dithered
3. Baja resolución — 320×240 con upscaling

4. Froxel Self Occlusion
5. Froxel Density Volumes
6. Light Shafts pixelados
7. Voxel Cone Tracing
8. Enemy AI
   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos

   Fase 3 — Polish
   └── AnimationStateMachine driven by BT state
   (idle → patrol → chase → attack)

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Non Priority

1. Editor Point Lights (Render Debug / Gizmo / Menu)
2. Editor Spot Lights (Render Debug / Gizmo / Menu)
3. Editor Light Probes (Render Debug / Gizmo)
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Blender Export with player spawn
6. Asset Browser + Spawn + Delete
7. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
8. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
9. Grain / Film grain - Ruido animado de película
10. Lens flares Oclusión + flare radial para el sol
11. Clearcoat - Segunda capa especular encima del PBR base
12. Sheen - Retroreflexión de telas
13. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)
14. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple
15. Staggered cascades
